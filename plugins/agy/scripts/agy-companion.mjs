#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseCommandInput } from "./lib/args.mjs";
import {
  assertNotNested,
  buildAgyArgs,
  getAgyAvailability,
  resolveAgyBinary,
  runAgy,
  validateEffort,
} from "./lib/agy.mjs";
import { buildReviewCollectionGuidance, buildReviewInputSection, collectReviewContext } from "./lib/git.mjs";
import {
  extractJsonObject,
  isReviewPayload,
  renderJobDetail,
  renderJobsTable,
  renderRawReview,
  renderReviewMarkdown,
} from "./lib/render.mjs";
import {
  getConfig,
  getJob,
  isProcessAlive,
  latestJob,
  listJobs,
  newJobId,
  resolveStateDir,
  resolveWorkspaceRoot,
  saveJob,
  setConfig,
  updateJob,
} from "./lib/state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

const READ_ONLY_SUFFIX = [
  "",
  "<execution_constraints>",
  "This is a read-only Antigravity run. Do not modify files, run mutating commands, or create commits.",
  "Do not write an implementation-plan artifact and do not ask for approval: answer directly in your final response.",
  "Do not invoke the agy CLI or any agy-rescue / agy-review skill; you are already the delegated agent.",
  "</execution_constraints>",
].join("\n");

const WRITE_SUFFIX = [
  "",
  "<execution_constraints>",
  "Do not invoke the agy CLI or any agy-rescue / agy-review skill; you are already the delegated agent.",
  "Do not create commits or push unless the task explicitly asks for it.",
  "</execution_constraints>",
].join("\n");

const REVIEW_TITLES = {
  review: "Antigravity Review",
  "adversarial-review": "Antigravity Adversarial Review",
};

function nowIso() {
  return new Date().toISOString();
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function readPromptTemplate(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
}

function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => String(variables[key] ?? ""));
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(options.cwd) : process.cwd();
}

function readPromptFile(workingDir, promptFile) {
  return fs.readFileSync(path.resolve(workingDir, promptFile), "utf8").trim();
}

// ---------------------------------------------------------------------------
// Job execution (shared by foreground runs and detached workers)
// ---------------------------------------------------------------------------

function renderJobOutput(job, result) {
  if (job.kind === "task") {
    return result.response || "(Antigravity returned an empty response.)";
  }
  const title = REVIEW_TITLES[job.kind];
  const payload = extractJsonObject(result.response);
  return isReviewPayload(payload)
    ? renderReviewMarkdown(title, job.request.targetLabel, payload)
    : renderRawReview(title, job.request.targetLabel, result.response);
}

function summarize(job, result) {
  if (job.kind !== "task") {
    const payload = extractJsonObject(result.response);
    if (isReviewPayload(payload)) {
      return `${payload.verdict}: ${payload.findings.length} finding(s)`;
    }
  }
  return String(result.response ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
}

async function executeJob(workspace, job) {
  updateJob(workspace, job.id, { status: "running", startedAt: nowIso(), pid: process.pid });
  try {
    const result = await runAgy(job.request.runCwd, job.request.agyArgs, {
      onSpawn: (child) => updateJob(workspace, job.id, { agyPid: child.pid }),
    });
    const output = renderJobOutput(job, result);
    const current = getJob(workspace, job.id);
    if (current?.status === "cancelled") {
      return current;
    }
    return updateJob(workspace, job.id, {
      status: "completed",
      finishedAt: nowIso(),
      conversationId: result.conversationId,
      usage: result.usage,
      rawOutput: result.response,
      output,
      summary: summarize(job, result),
    });
  } catch (error) {
    const current = getJob(workspace, job.id);
    if (current?.status === "cancelled") {
      return current;
    }
    return updateJob(workspace, job.id, { status: "failed", finishedAt: nowIso(), error: error.message });
  }
}

function launchWorker(workspace, job) {
  const logFile = path.join(resolveStateDir(workspace), "jobs", `${job.id}.log`);
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "_worker", job.id, "--cwd", workspace], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
  updateJob(workspace, job.id, { pid: child.pid, logFile });
}

const DEFAULT_FOREGROUND_WAIT_SECONDS = 540;

function resolveWaitSeconds(options) {
  const raw = options.waitTimeout ?? process.env.AGY_FOREGROUND_WAIT_SECS ?? DEFAULT_FOREGROUND_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid --wait-timeout "${raw}". Expected a positive number of seconds.`);
  }
  return seconds;
}

async function submitJob({ kind, title, write, runCwd, agyArgs, targetLabel, background, json, waitSeconds }) {
  const workspace = resolveWorkspaceRoot(runCwd);
  const job = {
    id: newJobId(kind),
    kind,
    title,
    write,
    cwd: workspace,
    status: "queued",
    createdAt: nowIso(),
    request: { runCwd, agyArgs, targetLabel },
  };
  saveJob(workspace, job);

  if (background) {
    launchWorker(workspace, job);
    if (json) {
      out(JSON.stringify({ jobId: job.id, status: "queued", background: true }, null, 2));
      return;
    }
    out(
      [
        `Antigravity ${kind} started in the background as ${job.id}.`,
        `Check progress with /agy:status ${job.id}; fetch output with /agy:result ${job.id}.`,
      ].join("\n")
    );
    return;
  }

  // Foreground runs still execute in a detached worker. Claude Code's Bash tool
  // kills commands after its timeout (2 min by default, 10 max), and agy runs
  // often take longer; waiting with a deadline lets us hand back a job id
  // instead of dying silently and losing the run.
  launchWorker(workspace, job);
  const deadline = Date.now() + waitSeconds * 1000;
  let finished = getJob(workspace, job.id);
  while ((finished.status === "queued" || finished.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    finished = getJob(workspace, job.id);
  }

  if (finished.status === "queued" || finished.status === "running") {
    if (json) {
      out(JSON.stringify({ jobId: finished.id, status: finished.status, conversationId: null, rawOutput: null, error: null }, null, 2));
    } else {
      out(
        [
          `Antigravity ${kind} ${finished.id} is still running after ${waitSeconds}s; it continues in the background.`,
          `Check progress with /agy:status ${finished.id}; fetch output with /agy:result ${finished.id}.`,
        ].join("\n")
      );
    }
    return;
  }

  if (json) {
    out(
      JSON.stringify(
        {
          jobId: finished.id,
          status: finished.status,
          conversationId: finished.conversationId ?? null,
          rawOutput: finished.rawOutput ?? null,
          error: finished.error ?? null,
        },
        null,
        2
      )
    );
  } else if (finished.status === "completed") {
    out(finished.output);
  } else {
    process.stderr.write(`Error: ${finished.error ?? `job ${finished.status}`}\n`);
  }
  if (finished.status !== "completed") {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handleSetup(rawArgs) {
  const { options } = parseCommandInput(rawArgs, {
    valueFlags: ["cwd"],
    booleanFlags: ["json", "enableReviewGate", "disableReviewGate"],
  });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));

  if (options.enableReviewGate && options.disableReviewGate) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options.enableReviewGate) {
    setConfig(workspace, { stopReviewGate: true });
  } else if (options.disableReviewGate) {
    setConfig(workspace, { stopReviewGate: false });
  }

  const agy = getAgyAvailability();
  let authenticated = null;
  let authDetail = null;
  if (agy.available) {
    const models = spawnSync(agy.bin, ["models"], { encoding: "utf8", timeout: 60000 });
    authenticated = models.status === 0 && /\S+\t\S+/.test(models.stdout ?? "");
    if (!authenticated) {
      authDetail = (models.stderr || models.stdout || models.error?.message || "").trim().split("\n").slice(-3).join(" ");
    }
  }
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });

  const report = {
    ready: agy.available && authenticated !== false && git.status === 0,
    agy: { available: agy.available, binary: agy.bin, version: agy.version, detail: agy.detail },
    authenticated,
    authDetail,
    git: git.status === 0 ? git.stdout.trim() : null,
    node: process.version,
    npmAvailable: npm.status === 0,
    workspace,
    stateDir: resolveStateDir(workspace),
    stopReviewGate: getConfig(workspace).stopReviewGate,
  };

  if (options.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    const lines = [
      "# Antigravity plugin setup",
      "",
      `- Status: ${report.ready ? "ready" : "not ready"}`,
      `- Antigravity CLI: ${agy.available ? `${agy.bin} (${agy.version})` : `not found (${agy.bin})`}`,
      `- Signed in: ${authenticated === null ? "unknown" : authenticated ? "yes" : "no"}`,
      `- Git: ${report.git ?? "not found"}`,
      `- Node: ${report.node}`,
      `- Stop-time review gate: ${report.stopReviewGate ? "enabled" : "disabled"} for ${workspace}`,
    ];
    if (!agy.available) {
      lines.push("", "Install Antigravity from https://antigravity.google and make sure `agy` is on PATH (or set AGY_BIN).");
    } else if (authenticated === false) {
      lines.push("", "Antigravity is installed but `agy models` failed. Sign in by running `!agy` once interactively.");
      if (authDetail) {
        lines.push(`Detail: ${authDetail}`);
      }
    }
    out(lines.join("\n"));
  }
  if (!report.ready) {
    process.exitCode = 1;
  }
}

function resolveContinuation(workspace, options) {
  if (options.conversation) {
    return { conversationId: options.conversation };
  }
  if (options.resume || options.resumeLast) {
    const previous = latestJob(workspace, (job) => job.kind === "task" && job.conversationId);
    if (previous) {
      return { conversationId: previous.conversationId };
    }
    process.stderr.write("No previous Antigravity task conversation in this workspace; starting a fresh one.\n");
  }
  return {};
}

async function handleTask(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, {
    valueFlags: ["model", "effort", "cwd", "promptFile", "conversation", "timeout", "waitTimeout"],
    booleanFlags: ["write", "readOnly", "resume", "resumeLast", "fresh", "json", "background", "wait"],
    aliases: { "--read-only": "readOnly", "--resume-last": "resumeLast", "--prompt-file": "promptFile" },
  });
  assertNotNested();
  validateEffort(options.effort);
  if ((options.resume || options.resumeLast) && options.fresh) {
    throw new Error("Choose either --resume or --fresh, not both.");
  }
  if (options.write && options.readOnly) {
    throw new Error("Choose either --write or --read-only, not both.");
  }

  const runCwd = resolveCwd(options);
  const promptText = options.promptFile ? readPromptFile(runCwd, options.promptFile) : positionals.join(" ").trim();
  if (!promptText) {
    throw new Error("Missing task prompt. Pass a prompt string or --prompt-file <path>.");
  }

  const write = Boolean(options.write);
  const workspace = resolveWorkspaceRoot(runCwd);
  const agyArgs = buildAgyArgs({
    write,
    model: options.model,
    effort: options.effort,
    timeout: options.timeout,
    ...resolveContinuation(workspace, options),
    prompt: `${promptText}\n${write ? WRITE_SUFFIX : READ_ONLY_SUFFIX}`,
  });

  await submitJob({
    kind: "task",
    title: promptText.split(/\r?\n/).find((line) => line.trim()) ?? "task",
    write,
    runCwd,
    agyArgs,
    background: Boolean(options.background),
    json: Boolean(options.json),
    waitSeconds: options.background ? 0 : resolveWaitSeconds(options),
  });
}

async function handleReview(kind, rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, {
    valueFlags: ["base", "scope", "model", "effort", "cwd", "promptFile", "timeout", "waitTimeout"],
    booleanFlags: ["json", "background", "wait"],
    aliases: { "--prompt-file": "promptFile" },
  });
  assertNotNested();
  validateEffort(options.effort);

  const workingDir = resolveCwd(options);
  let focusText = positionals.join(" ").trim();
  if (options.promptFile) {
    const fileText = readPromptFile(workingDir, options.promptFile);
    focusText = focusText ? `${focusText}\n\n${fileText}` : fileText;
  }

  const context = collectReviewContext(workingDir, {
    base: options.base,
    scope: options.scope ?? "auto",
    focusText,
    hasPromptFile: Boolean(options.promptFile),
  });

  const prompt = interpolateTemplate(readPromptTemplate(kind), {
    TARGET_LABEL: context.label,
    USER_FOCUS: focusText || (kind === "adversarial-review" ? "full adversarial engineering review" : "general correctness review"),
    REVIEW_COLLECTION_GUIDANCE: buildReviewCollectionGuidance(context),
    REVIEW_INPUT: buildReviewInputSection(context),
  });

  // agy --json-schema rejects draft 2020-12 schemas when tools are active, so
  // the output contract lives in the prompt and extractJsonObject() parses it.
  const agyArgs = buildAgyArgs({
    write: false,
    model: options.model,
    effort: options.effort,
    timeout: options.timeout,
    prompt: `${prompt}\n${READ_ONLY_SUFFIX}`,
  });

  await submitJob({
    kind,
    title: `${context.label}${focusText ? ` — ${focusText}` : ""}`,
    write: false,
    runCwd: context.repoRoot,
    agyArgs,
    targetLabel: context.label,
    background: Boolean(options.background),
    json: Boolean(options.json),
    waitSeconds: options.background ? 0 : resolveWaitSeconds(options),
  });
}

function handleStatus(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, {
    valueFlags: ["cwd", "timeoutMs"],
    booleanFlags: ["json", "all", "wait"],
    aliases: { "--timeout-ms": "timeoutMs" },
  });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const [jobId] = positionals;

  if (jobId) {
    let job = getJob(workspace, jobId);
    if (!job) {
      throw new Error(`No Antigravity job "${jobId}" in this workspace.`);
    }
    if (options.wait) {
      const deadline = Date.now() + Number(options.timeoutMs ?? 10 * 60 * 1000);
      while ((job.status === "running" || job.status === "queued") && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        job = getJob(workspace, jobId);
      }
    }
    out(options.json ? JSON.stringify(stripRequest(job), null, 2) : renderJobDetail(job));
    return;
  }

  const jobs = listJobs(workspace).slice(0, options.all ? undefined : 10);
  if (options.json) {
    out(JSON.stringify(jobs.map(stripRequest), null, 2));
    return;
  }
  out(renderJobsTable(jobs, { gateEnabled: getConfig(workspace).stopReviewGate }));
}

function stripRequest(job) {
  const { request, output, rawOutput, ...rest } = job;
  return rest;
}

function pickJob(workspace, jobId, predicate) {
  if (jobId) {
    const job = getJob(workspace, jobId);
    if (!job) {
      throw new Error(`No Antigravity job "${jobId}" in this workspace.`);
    }
    return job;
  }
  const job = latestJob(workspace, predicate);
  if (!job) {
    throw new Error("No matching Antigravity job in this workspace. Run /agy:status to list jobs.");
  }
  return job;
}

function handleResult(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, { valueFlags: ["cwd"], booleanFlags: ["json"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const job = pickJob(workspace, positionals[0], (candidate) => candidate.status !== "running" && candidate.status !== "queued");

  if (options.json) {
    const { request, ...rest } = job;
    out(JSON.stringify(rest, null, 2));
    return;
  }
  if (job.status === "running" || job.status === "queued") {
    out(`Job ${job.id} is still ${job.status}. Check /agy:status ${job.id}.`);
    return;
  }
  const header = [`Job: ${job.id} (${job.kind}, ${job.status})`];
  if (job.conversationId) {
    header.push(`Antigravity conversation: ${job.conversationId}`);
  }
  if (job.status === "completed") {
    out([...header, "", job.output].join("\n"));
  } else {
    out([...header, "", `Error: ${job.error ?? "no output recorded"}`].join("\n"));
    process.exitCode = 1;
  }
}

function killPid(pid, { group = false } = {}) {
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(group ? -pid : pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function handleCancel(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, { valueFlags: ["cwd"], booleanFlags: ["json"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const job = pickJob(workspace, positionals[0], (candidate) => candidate.status === "running" || candidate.status === "queued");

  if (job.status !== "running" && job.status !== "queued") {
    out(`Job ${job.id} is already ${job.status}; nothing to cancel.`);
    return;
  }
  updateJob(workspace, job.id, { status: "cancelled", finishedAt: nowIso(), error: "Cancelled by user." });
  const killedAgy = killPid(job.agyPid);
  const killedWorker = job.logFile ? killPid(job.pid, { group: true }) : false;
  out(
    options.json
      ? JSON.stringify({ jobId: job.id, status: "cancelled", killedAgy, killedWorker }, null, 2)
      : `Cancelled Antigravity job ${job.id}.`
  );
}

function handleResumeCandidate(rawArgs) {
  const { options } = parseCommandInput(rawArgs, { valueFlags: ["cwd"], booleanFlags: ["json"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const previous = latestJob(workspace, (job) => job.kind === "task" && job.conversationId);
  const payload = previous
    ? { available: true, jobId: previous.id, conversationId: previous.conversationId, title: previous.title, finishedAt: previous.finishedAt }
    : { available: false };
  out(options.json ? JSON.stringify(payload, null, 2) : payload.available ? `Resumable: ${payload.jobId} — ${payload.title}` : "No resumable Antigravity task.");
}

async function handleWorker(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, { valueFlags: ["cwd"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const job = getJob(workspace, positionals[0]);
  if (!job || job.status === "cancelled") {
    return;
  }
  await executeJob(workspace, job);
}

function printHelp() {
  out(
    [
      "Usage: agy-companion.mjs <subcommand> [options]",
      "",
      "Subcommands:",
      "  setup [--json] [--enable-review-gate|--disable-review-gate]",
      "  task [--write|--read-only] [--resume|--fresh] [--conversation <id>] [--model <m>] [--effort <low|medium|high|xhigh|max>] [--timeout <dur>] [--background] [--wait-timeout <secs>] [--prompt-file <path>] [--json] [prompt]",
      "  review [--base <ref>] [--scope auto|working-tree|branch|decision] [--background] [--json] [focus]",
      "  adversarial-review [--base <ref>] [--scope auto|working-tree|branch|decision] [--prompt-file <path>] [--background] [--json] [focus or decision brief]",
      "  status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  result [job-id] [--json]",
      "  cancel [job-id] [--json]",
      "  task-resume-candidate [--json]",
      "",
      `Antigravity binary: ${resolveAgyBinary()} (override with AGY_BIN)`,
    ].join("\n")
  );
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const args = normalizeArgv(rest);
  if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) {
    printHelp();
    return;
  }

  switch (subcommand) {
    case "setup":
      return handleSetup(args);
    case "task":
      return handleTask(args);
    case "review":
    case "adversarial-review":
      return handleReview(subcommand, args);
    case "status":
      return handleStatus(args);
    case "result":
      return handleResult(args);
    case "cancel":
      return handleCancel(args);
    case "task-resume-candidate":
      return handleResumeCandidate(args);
    case "_worker":
      return handleWorker(args);
    default:
      throw new Error(`Unknown subcommand "${subcommand}". Run with --help for usage.`);
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
