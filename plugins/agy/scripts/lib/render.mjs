const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const NON_FILE_TARGETS = new Set(["decision", "n/a", "none", "general", ""]);

export function extractJsonObject(rawText) {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // try a fenced block or the outermost braces
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

export function isReviewPayload(payload) {
  return Boolean(payload && typeof payload.verdict === "string" && Array.isArray(payload.findings));
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
    const start = finding.line_start ?? finding.start_line;
    const end = finding.line_end ?? finding.end_line;
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
    `- Mode: ${job.write ? "write (agy --mode auto)" : "read-only (agy --mode plan)"}`,
    `- Workspace: ${job.cwd}`,
    `- Created: ${job.createdAt}`,
    job.finishedAt ? `- Finished: ${job.finishedAt}` : null,
    `- Elapsed: ${elapsed(job)}`,
    job.conversationId ? `- Antigravity conversation: ${job.conversationId}` : null,
    job.error ? `- Error: ${job.error}` : null,
    "",
    job.status === "running" || job.status === "queued"
      ? `Still running. Cancel with /agy:cancel ${job.id}.`
      : `Full output: /agy:result ${job.id}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
