import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const NON_FILE_TARGETS = new Set(["decision", "n/a", "none", "general", ""]);

// Candidate JSON texts, most likely first: the whole output, fenced blocks
// from last to first, then balanced {...} spans from last to first.
function jsonCandidates(text) {
  const candidates = [text];
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1].trim());
  candidates.push(...fences.reverse());
  const spans = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") {
          i += 1;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  candidates.push(...spans.sort((a, b) => b.length - a.length));
  return candidates;
}

export function extractJsonObject(rawText, accept = (value) => value && typeof value === "object") {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) {
    return null;
  }
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      const value = JSON.parse(candidate);
      if (accept(value)) {
        return value;
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "review-output.schema.json"), "utf8")
);
const FINDING_SCHEMA = SCHEMA.properties.findings.items;

function matchesType(value, spec) {
  switch (spec.type) {
    case "string":
      return typeof value === "string" && (!spec.enum || spec.enum.includes(value));
    case "integer":
      return Number.isInteger(value) && (spec.minimum == null || value >= spec.minimum);
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (spec.minimum == null || value >= spec.minimum) &&
        (spec.maximum == null || value <= spec.maximum)
      );
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

// Validates against schemas/review-output.schema.json. Line numbers are
// coerced (models often send 0 or strings for non-file findings).
export function normalizeReviewPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const key of SCHEMA.required) {
    if (!(key in value)) {
      return null;
    }
  }
  if (!matchesType(value.verdict, SCHEMA.properties.verdict) || !Array.isArray(value.findings)) {
    return null;
  }
  const findings = [];
  for (const raw of value.findings) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const finding = { ...raw };
    for (const key of ["line_start", "line_end"]) {
      const n = Number.parseInt(finding[key] ?? finding[key.replace("line_", "") + "_line"] ?? 1, 10);
      finding[key] = Number.isInteger(n) && n >= 1 ? n : 1;
    }
    for (const key of FINDING_SCHEMA.required) {
      if (!(key in finding) || !matchesType(finding[key], FINDING_SCHEMA.properties[key])) {
        return null;
      }
    }
    findings.push(finding);
  }
  return {
    verdict: value.verdict,
    summary: String(value.summary ?? ""),
    findings,
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.map(String) : [],
  };
}

export function extractReviewPayload(rawText) {
  return normalizeReviewPayload(extractJsonObject(rawText, (value) => normalizeReviewPayload(value) !== null));
}

export function sortFindings(findings) {
  if (!Array.isArray(findings)) {
    return [];
  }
  return [...findings].sort((left, right) => {
    const delta = (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99);
    return delta !== 0 ? delta : (right.confidence ?? 0) - (left.confidence ?? 0);
  });
}

function formatFinding(finding) {
  const file = String(finding.file ?? "").trim();
  let location = "";
  if (!NON_FILE_TARGETS.has(file.toLowerCase())) {
    const start = finding.line_start;
    const end = finding.line_end;
    const range = end && end !== start ? `${start}-${end}` : start ? `${start}` : "";
    location = range ? ` (${file}:${range})` : ` (${file})`;
  }
  const confidence = typeof finding.confidence === "number" ? ` · confidence ${finding.confidence}` : "";
  return [
    `- [${finding.severity}] ${finding.title}${location}${confidence}`,
    `  ${finding.body}`,
    finding.recommendation ? `  Recommendation: ${finding.recommendation}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderReviewMarkdown(title, targetLabel, payload) {
  const findings = sortFindings(payload.findings);
  const lines = [`# ${title}`, "", `Target: ${targetLabel}`, `Verdict: ${payload.verdict}`, "", payload.summary ?? "", ""];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("## Findings", "", ...findings.map(formatFinding));
  }

  if (Array.isArray(payload.next_steps) && payload.next_steps.length > 0) {
    lines.push("", "## Next Steps", "", ...payload.next_steps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

export function renderRawReview(title, targetLabel, text) {
  return [`# ${title}`, "", `Target: ${targetLabel}`, "", "_Antigravity did not return structured JSON; raw output follows._", "", text].join("\n");
}

function elapsed(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

function oneLine(text, max = 70) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderJobsTable(jobs, { gateEnabled } = {}) {
  const lines = ["# Antigravity jobs", "", `Stop-time review gate: ${gateEnabled ? "enabled" : "disabled"}`, ""];
  if (jobs.length === 0) {
    lines.push("No Antigravity jobs recorded for this workspace.");
    return lines.join("\n");
  }
  lines.push("| Job | Kind | Status | Mode | Elapsed | Summary | Follow-up |", "|---|---|---|---|---|---|---|");
  for (const job of jobs) {
    const follow =
      job.status === "running" || job.status === "queued"
        ? `/agy:status ${job.id} · /agy:cancel ${job.id}`
        : `/agy:result ${job.id}`;
    lines.push(
      `| ${job.id} | ${job.kind} | ${job.status} | ${job.write ? "write" : "read-only"} | ${elapsed(job)} | ${oneLine(job.summary || job.error || job.title).replace(/\|/g, "\\|")} | ${follow} |`
    );
  }
  return lines.join("\n");
}

export function renderJobDetail(job) {
  return [
    `# Antigravity job ${job.id}`,
    "",
    `- Kind: ${job.kind}`,
    `- Status: ${job.status}`,
    `- Mode: ${job.write ? "write" : "read-only (agy plan mode + sandbox, workspace integrity-checked)"}`,
    `- Workspace: ${job.cwd}`,
    `- Created: ${job.createdAt}`,
    job.finishedAt ? `- Finished: ${job.finishedAt}` : null,
    `- Elapsed: ${elapsed(job)}`,
    job.conversationId ? `- Antigravity conversation: ${job.conversationId}` : null,
    job.error ? `- Error: ${job.error}` : null,
    job.modifiedFiles?.length ? `- Modified during read-only run: ${job.modifiedFiles.join(", ")}` : null,
    ...(job.warnings ?? []).map((warning) => `- agy ${warning}`),
    "",
    job.status === "running" || job.status === "queued"
      ? `Still running. Cancel with /agy:cancel ${job.id}.`
      : `Full output: /agy:result ${job.id}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
