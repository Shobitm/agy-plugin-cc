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
  runAgySync,
  validateEffort,
} from "./lib/agy.mjs";
import {
  buildReviewCollectionGuidance,
  buildReviewInputSection,
  collectReviewContext,
  diffFingerprints,
  newBoundary,
  wrapUntrusted,
  workspaceFingerprint,
} from "./lib/git.mjs";
import { killTree, processStartTime } from "./lib/proc.mjs";
import { extractReviewPayload, renderJobDetail, renderJobsTable, renderRawReview, renderReviewMarkdown } from "./lib/render.mjs";
import {
  ACTIVE_STATUSES,
  getConfig,
  getJob,
  jobLogFile,
  latestJob,
  listJobs,
  newJobId,
  resolveStateDir,
  stateRoot,
  resolveWorkspaceRoot,
  saveJob,
  setConfig,
  updateJob,
} from "./lib/state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_FOREGROUND_WAIT_SECONDS = 540;

const READ_ONLY_SUFFIX = [
  "",
  "<execution_constraints>",
  "This is a read-only Antigravity run. Do not modify, create, or delete files, run mutating commands, or create commits.",
  "The workspace is fingerprinted before and after this run; any change fails the run.",
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

function resolveWaitSeconds(options) {
  const raw = options.waitTimeout ?? process.env.AGY_FOREGROUND_WAIT_SECS ?? DEFAULT_FOREGROUND_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid --wait-timeout "${raw}". Expected a positive number of seconds.`);
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Job execution. Every run (foreground or background) executes in a detached
// worker that owns the job's lifecycle; the launching process only waits.
// ---------------------------------------------------------------------------

function renderJobOutput(job, response) {
  if (job.kind !== "review" && job.kind !== "adversarial-review") {
    return response || "(Antigravity returned an empty response.)";
  }
  const title = REVIEW_TITLES[job.kind];
  const payload = extractReviewPayload(response);
  return payload ? renderReviewMarkdown(title, job.request.targetLabel, payload) : renderRawReview(title, job.request.targetLabel, response);
}

function summarize(job, response) {
  if (job.kind === "review" || job.kind === "adversarial-review") {
    const payload = extractReviewPayload(response);
    if (payload) {
      return `${payload.verdict}: ${payload.findings.length} finding(s)`;
    }
  }
  return String(response ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
}

async function executeJob(workspace, job) {
  let agyChild = null;
  const onTerminate = (sig) => {
    updateJob(workspace, job.id, { status: "cancelled", finishedAt: nowIso(), error: `Worker received ${sig}.` });
    if (agyChild?.pid) {
      killTree(agyChild.pid, { graceMs: 2000 });
    }
    process.exit(1);
  };
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  process.once("SIGHUP", onTerminate);

  const running = updateJob(workspace, job.id, {
    status: "running",
    startedAt: nowIso(),
    pid: process.pid,
    pidStart: processStartTime(process.pid),
  });
  if (running.status !== "running") {
    return running;
  }

  const fingerprint = () => workspaceFingerprint(job.request.runCwd, { exclude: [stateRoot()] });
  const before = job.write ? null : fingerprint();
  try {
    const result = await runAgy(job.request.runCwd, job.request.agyArgs, {
      onSpawn: (child) => {
        agyChild = child;
        updateJob(workspace, job.id, { agyPid: child.pid, agyPidStart: processStartTime(child.pid) });
      },
    });
    const modified = before ? diffFingerprints(before, fingerprint()) : [];
    if (modified.length > 0) {
      return updateJob(workspace, job.id, {
        status: "failed",
        finishedAt: nowIso(),
        conversationId: result.conversationId,
        rawOutput: result.response,
        modifiedFiles: modified,
        error: `Read-only run modified the workspace (${modified.length} path(s)): ${modified.slice(0, 20).join(", ")}. Review and revert with git if unintended.`,
      });
    }
    return updateJob(workspace, job.id, {
      status: "completed",
      finishedAt: nowIso(),
      conversationId: result.conversationId,
      usage: result.usage,
      warnings: result.warnings,
      rawOutput: result.response,
      output: renderJobOutput(job, result.response),
      summary: summarize(job, result.response),
    });
  } catch (error) {
    return updateJob(workspace, job.id, { status: "failed", finishedAt: nowIso(), error: error.message });
  }
}

function launchWorker(workspace, job) {
  const logFd = fs.openSync(jobLogFile(workspace, job.id), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "_worker", job.id, "--cwd", workspace], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
}

function jobResultJson(job) {
  return JSON.stringify(
    {
      jobId: job.id,
      status: job.status,
      conversationId: job.conversationId ?? null,
      rawOutput: job.rawOutput ?? null,
      error: job.error ?? null,
      modifiedFiles: job.modifiedFiles ?? [],
    },
    null,
    2
  );
}

async function waitForJob(workspace, id, deadline) {
  let job = getJob(workspace, id);
  while (job && ACTIVE_STATUSES.has(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = getJob(workspace, id);
  }
  return job;
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
  launchWorker(workspace, job);

  if (background) {
    out(
      json
        ? JSON.stringify({ jobId: job.id, status: "queued", background: true }, null, 2)
        : [
            `Antigravity ${kind} started in the background as ${job.id}.`,
            `Check progress with /agy:status ${job.id}; fetch output with /agy:result ${job.id}.`,
          ].join("\n")
    );
    return job;
  }

  // Announce the job id at once: if the caller's shell kills this command
  // before the deadline below, the id is already on screen and the detached
  // run can still be collected with `result <id> --wait`.
  process.stderr.write(`agy job ${job.id} started (collect with: result ${job.id} --wait)\n`);

  // Claude Code's Bash tool kills commands after its timeout (2 min default,
  // 10 max) and agy runs often take longer: wait with a deadline and hand
  // back the job id instead of dying silently and losing the run.
  const finished = await waitForJob(workspace, job.id, Date.now() + waitSeconds * 1000);

  if (ACTIVE_STATUSES.has(finished.status)) {
    out(
      json
        ? jobResultJson(finished)
        : [
            `STILL_RUNNING ${finished.id}: Antigravity ${kind} is still running after ${waitSeconds}s; it continues in the background.`,
            `Keep waiting with \`result ${finished.id} --wait\`, check progress with /agy:status ${finished.id}, or fetch output later with /agy:result ${finished.id}.`,
          ].join("\n")
    );
    return finished;
  }

  if (json) {
    out(jobResultJson(finished));
  } else if (finished.status === "completed") {
    out(finished.output);
  } else {
    process.stderr.write(`Error: ${finished.error ?? `job ${finished.status}`}\n`);
  }
  if (finished.status !== "completed") {
    process.exitCode = 1;
  }
  return finished;
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
    const models = runAgySync(["models"], { timeout: 60000 });
    authenticated = models.status === 0 && /\S+\t\S+/.test(models.stdout ?? "");
    if (!authenticated) {
      authDetail = (models.stderr || models.stdout || models.error?.message || "").trim().split("\n").slice(-3).join(" ");
    }
  }
  const git = runGitVersion();

  const report = {
    ready: agy.available && authenticated !== false && Boolean(git),
    agy: { available: agy.available, binary: agy.bin, version: agy.version, detail: agy.detail },
    authenticated,
    authDetail,
    git,
    node: process.version,
    workspace,
    stateDir: resolveStateDir(workspace),
    writeMode: process.env.AGY_WRITE_MODE || "default",
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
      `- Write mode: agy ${report.writeMode} mode (set AGY_WRITE_MODE=auto|accept-edits to change)`,
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

function runGitVersion() {
  const res = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

function lastTaskConversation(workspace) {
  return latestJob(workspace, (job) => job.kind === "task" && job.conversationId);
}

function resolveContinuation(workspace, options) {
  if (options.conversation) {
    return { conversationId: options.conversation };
  }
  if (options.resume || options.resumeLast) {
    const previous = lastTaskConversation(workspace);
    if (previous) {
      return { conversationId: previous.conversationId };
    }
    process.stderr.write("No previous Antigravity task conversation in this workspace; starting a fresh one.\n");
  }
  return {};
}

async function handleTask(rawArgs, { kind = "task" } = {}) {
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
  if (kind === "gate" && options.write) {
    throw new Error("Gate runs are always read-only.");
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
    ...(kind === "gate" ? {} : resolveContinuation(workspace, options)),
    prompt: `${promptText}\n${write ? WRITE_SUFFIX : READ_ONLY_SUFFIX}`,
  });

  return submitJob({
    kind,
    title: promptText.split(/\r?\n/).find((line) => line.trim()) ?? kind,
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

  const boundary = newBoundary();
  const defaultFocus = kind === "adversarial-review" ? "full adversarial engineering review" : "general correctness review";
  const prompt = interpolateTemplate(readPromptTemplate(kind), {
    TARGET_LABEL: context.label,
    USER_FOCUS: context.mode === "prompt" ? "see the brief in the review input" : focusText ? wrapUntrusted(boundary, [focusText]) : defaultFocus,
    REVIEW_COLLECTION_GUIDANCE: buildReviewCollectionGuidance(context),
    REVIEW_INPUT: buildReviewInputSection(context, boundary),
  });

  // agy --json-schema rejects schemas when tools are active, so the output
  // contract lives in the prompt and extractReviewPayload() validates it.
  const agyArgs = buildAgyArgs({
    write: false,
    model: options.model,
    effort: options.effort,
    timeout: options.timeout,
    prompt: `${prompt}\n${READ_ONLY_SUFFIX}`,
  });

  return submitJob({
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

function stripRequest(job) {
  const { request, output, rawOutput, ...rest } = job;
  return rest;
}

async function handleStatus(rawArgs) {
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
      const timeoutMs = Number(options.timeoutMs ?? 10 * 60 * 1000);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`Invalid --timeout-ms "${options.timeoutMs}".`);
      }
      job = (await waitForJob(workspace, jobId, Date.now() + timeoutMs)) ?? job;
      if (ACTIVE_STATUSES.has(job.status)) {
        process.exitCode = 2;
      }
    }
    out(options.json ? JSON.stringify(stripRequest(job), null, 2) : renderJobDetail(job));
    return;
  }

  const jobs = listJobs(workspace, { includeGate: Boolean(options.all) }).slice(0, options.all ? undefined : 10);
  if (options.json) {
    out(JSON.stringify(jobs.map(stripRequest), null, 2));
    return;
  }
  out(renderJobsTable(jobs, { gateEnabled: getConfig(workspace).stopReviewGate }));
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

async function handleResult(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, {
    valueFlags: ["cwd", "timeoutMs"],
    booleanFlags: ["json", "wait"],
    aliases: { "--timeout-ms": "timeoutMs" },
  });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  let job = pickJob(workspace, positionals[0], (candidate) => !ACTIVE_STATUSES.has(candidate.status));

  // `result <id> --wait` blocks until the job finishes (bounded so it fits in
  // one Bash call); exit code 2 means "still running, call again".
  if (options.wait && ACTIVE_STATUSES.has(job.status)) {
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_FOREGROUND_WAIT_SECONDS * 1000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid --timeout-ms "${options.timeoutMs}".`);
    }
    job = (await waitForJob(workspace, job.id, Date.now() + timeoutMs)) ?? job;
    if (ACTIVE_STATUSES.has(job.status)) {
      out(
        options.json
          ? JSON.stringify({ jobId: job.id, status: job.status }, null, 2)
          : `STILL_RUNNING ${job.id}: Antigravity is still working. Run \`result ${job.id} --wait\` again to keep waiting.`
      );
      process.exitCode = 2;
      return;
    }
  }

  if (options.json) {
    const { request, ...rest } = job;
    out(JSON.stringify(rest, null, 2));
    return;
  }
  if (ACTIVE_STATUSES.has(job.status)) {
    out(`Job ${job.id} is still ${job.status}. Check /agy:status ${job.id}.`);
    return;
  }
  const header = [`Job: ${job.id} (${job.kind}, ${job.status})`];
  if (job.conversationId) {
    header.push(`Antigravity conversation: ${job.conversationId}`);
  }
  for (const warning of job.warnings ?? []) {
    header.push(`agy ${warning}`);
  }
  if (job.status === "completed") {
    out([...header, "", job.output].join("\n"));
    return;
  }
  const body = [...header, "", `Error: ${job.error ?? "no output recorded"}`];
  if (job.rawOutput) {
    body.push("", "Antigravity output:", job.rawOutput);
  }
  out(body.join("\n"));
  process.exitCode = 1;
}

export function cancelJob(workspace, job) {
  const updated = updateJob(workspace, job.id, { status: "cancelled", finishedAt: nowIso(), error: "Cancelled by user." });
  if (updated.status !== "cancelled") {
    return { cancelled: false, status: updated.status };
  }
  // Only signal processes whose identity (pid + start time) still matches.
  const killedWorker = job.pid && job.pidStart && processStartTime(job.pid) === job.pidStart ? killTree(job.pid, { group: true }) : false;
  const killedAgy =
    job.agyPid && job.agyPidStart && processStartTime(job.agyPid) === job.agyPidStart ? killTree(job.agyPid) : false;
  return { cancelled: true, killedWorker, killedAgy };
}

function handleCancel(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, { valueFlags: ["cwd"], booleanFlags: ["json"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const job = pickJob(workspace, positionals[0], (candidate) => ACTIVE_STATUSES.has(candidate.status));

  if (!ACTIVE_STATUSES.has(job.status)) {
    out(`Job ${job.id} is already ${job.status}; nothing to cancel.`);
    return;
  }
  const result = cancelJob(workspace, job);
  if (options.json) {
    out(JSON.stringify({ jobId: job.id, ...result }, null, 2));
  } else {
    out(result.cancelled ? `Cancelled Antigravity job ${job.id}.` : `Job ${job.id} already finished (${result.status}).`);
  }
}

function handleResumeCandidate(rawArgs) {
  const { options } = parseCommandInput(rawArgs, { valueFlags: ["cwd"], booleanFlags: ["json"] });
  const previous = lastTaskConversation(resolveWorkspaceRoot(resolveCwd(options)));
  const payload = previous
    ? { available: true, jobId: previous.id, conversationId: previous.conversationId, title: previous.title, finishedAt: previous.finishedAt }
    : { available: false };
  out(options.json ? JSON.stringify(payload, null, 2) : payload.available ? `Resumable: ${payload.jobId} — ${payload.title}` : "No resumable Antigravity task.");
}

async function handleWorker(rawArgs) {
  const { options, positionals } = parseCommandInput(rawArgs, { valueFlags: ["cwd"] });
  const workspace = resolveWorkspaceRoot(resolveCwd(options));
  const job = getJob(workspace, positionals[0]);
  if (!job || job.status !== "queued") {
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
      "  review [--base <ref>] [--scope auto|working-tree|branch|decision] [--background] [--wait-timeout <secs>] [--json] [focus]",
      "  adversarial-review [--base <ref>] [--scope auto|working-tree|branch|decision] [--prompt-file <path>] [--background] [--wait-timeout <secs>] [--json] [focus or decision brief]",
      "  status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  result [job-id] [--wait] [--timeout-ms <ms>] [--json]",
      "  cancel [job-id] [--json]",
      "  task-resume-candidate [--json]",
      "",
      `Antigravity binary: ${resolveAgyBinary()} (override with AGY_BIN)`,
    ].join("\n")
  );
}

// Subcommands without free text always receive a packed "$ARGUMENTS".
const ALWAYS_SPLIT = new Set(["setup", "status", "result", "cancel", "task-resume-candidate"]);

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) {
    printHelp();
    return;
  }
  const args = normalizeArgv(rest, { alwaysSplit: ALWAYS_SPLIT.has(subcommand) });

  switch (subcommand) {
    case "setup":
      return handleSetup(args);
    case "task":
      return handleTask(args);
    case "_gate":
      return handleTask(args, { kind: "gate" });
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

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
