#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEPTH_ENV, getAgyAvailability } from "./lib/agy.mjs";
import { getConfig, listJobs, resolveWorkspaceRoot } from "./lib/state.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANUAL_HINT = "Run /agy:review --wait manually, or disable the gate with /agy:setup --disable-review-gate.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function note(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function buildPrompt(input) {
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md"), "utf8");
  const last = String(input.last_assistant_message ?? "").trim();
  return template.replace("{{CLAUDE_RESPONSE_BLOCK}}", last ? `Previous Claude response:\n${last}` : "");
}

export function parseGateAnswer(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { ok: false, reason: `The stop-time Antigravity review returned no output. ${MANUAL_HINT}` };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: `Antigravity stop-time review found issues to fix before ending: ${firstLine.slice(6).trim() || text}`,
    };
  }
  return { ok: false, reason: `The stop-time Antigravity review returned an unexpected answer. ${MANUAL_HINT}` };
}

function runGate(cwd, input) {
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPT_DIR, "agy-companion.mjs"), "task", "--read-only", "--json", "--cwd", cwd, buildPrompt(input)],
    { cwd, encoding: "utf8", timeout: STOP_REVIEW_TIMEOUT_MS }
  );
  if (result.error?.code === "ETIMEDOUT") {
    return { ok: false, reason: `The stop-time Antigravity review timed out after 15 minutes. ${MANUAL_HINT}` };
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (payload.status !== "completed") {
      return { ok: false, reason: `The stop-time Antigravity review failed: ${payload.error ?? payload.status}` };
    }
    return parseGateAnswer(payload.rawOutput);
  } catch {
    const detail = String(result.stderr || result.stdout || "").trim();
    return { ok: false, reason: `The stop-time Antigravity review failed${detail ? `: ${detail}` : "."} ${MANUAL_HINT}` };
  }
}

function main() {
  const input = readHookInput();
  // Never gate a Claude session that was itself launched by Antigravity, and
  // never re-enter the gate while Claude is already continuing because of it.
  if (process.env[DEPTH_ENV] || input.stop_hook_active) {
    return;
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspace = resolveWorkspaceRoot(cwd);

  const running = listJobs(workspace).find((job) => job.status === "running" || job.status === "queued");
  const runningNote = running
    ? `Antigravity job ${running.id} is still running. Check /agy:status, or /agy:cancel ${running.id} to stop it.`
    : null;

  if (!getConfig(workspace).stopReviewGate) {
    note(runningNote);
    return;
  }
  if (!getAgyAvailability().available) {
    note("Antigravity is not available for the stop-time review gate. Run /agy:setup.");
    note(runningNote);
    return;
  }

  const verdict = runGate(cwd, input);
  if (!verdict.ok) {
    process.stdout.write(
      `${JSON.stringify({ decision: "block", reason: runningNote ? `${runningNote} ${verdict.reason}` : verdict.reason })}\n`
    );
    return;
  }
  note(runningNote);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
