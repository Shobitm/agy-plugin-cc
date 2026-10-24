import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { STOP_HOOK, agyCalls, companion, makeSandbox, waitFor } from "./helpers.mjs";

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "Do not ship.",
  findings: [
    { severity: "high", title: "Overflow", body: "b", file: "app.js", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "r" },
  ],
  next_steps: ["fix overflow"],
});

test("setup reports readiness as JSON", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["setup", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.authenticated, true);
  assert.equal(report.stopReviewGate, false);
});

test("setup flags unauthenticated agy and toggles the gate", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["setup", "--json"], { FAKE_AGY_UNAUTH: "1" });
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).authenticated, false);
  assert.equal(JSON.parse(companion(sb, ["setup", "--json", "--enable-review-gate"]).stdout).stopReviewGate, true);
  assert.equal(JSON.parse(companion(sb, ["setup", "--json", "--disable-review-gate"]).stdout).stopReviewGate, false);
});

test("setup reports a missing binary", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["setup", "--json"], { AGY_BIN: path.join(sb.dir, "missing-agy") });
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).agy.available, false);
});

test("task defaults to read-only plan mode and records a job", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "diagnose the crash"], { FAKE_AGY_RESPONSE: "root cause: x" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "root cause: x");
  const [call] = agyCalls(sb);
  assert.deepEqual(call.args.slice(0, 2), ["--mode", "plan"]);
  assert.equal(call.depth, "1");
  assert.match(call.args.at(-1), /read-only Antigravity run/);

  const status = JSON.parse(companion(sb, ["status", "--json"]).stdout);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, "completed");
  assert.equal(status[0].conversationId, "conv-123");
});

test("--write uses auto mode", () => {
  const sb = makeSandbox();
  assert.equal(companion(sb, ["task", "--write", "fix it"]).status, 0);
  assert.deepEqual(agyCalls(sb)[0].args.slice(0, 2), ["--mode", "auto"]);
});

test("packed $ARGUMENTS string is unpacked", () => {
  const sb = makeSandbox();
  assert.equal(companion(sb, ["task", "--write --effort high fix the bug"]).status, 0);
  const { args } = agyCalls(sb)[0];
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.match(args.at(-1), /^fix the bug/);
});

test("--resume-last continues the previous task conversation", () => {
  const sb = makeSandbox();
  companion(sb, ["task", "first"], { FAKE_AGY_CONVERSATION: "conv-first" });
  const candidate = JSON.parse(companion(sb, ["task-resume-candidate", "--json"]).stdout);
  assert.equal(candidate.available, true);
  assert.equal(candidate.conversationId, "conv-first");

  companion(sb, ["task", "--resume-last", "keep going"]);
  const { args } = agyCalls(sb)[1];
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-first");
});

test("rejects conflicting and invalid flags", () => {
  const sb = makeSandbox();
  assert.match(companion(sb, ["task", "--write", "--read-only", "x"]).stderr, /either --write or --read-only/);
  assert.match(companion(sb, ["task", "--resume", "--fresh", "x"]).stderr, /either --resume or --fresh/);
  assert.match(companion(sb, ["task", "--effort", "ultra", "x"]).stderr, /Invalid --effort/);
  assert.match(companion(sb, ["task"]).stderr, /Missing task prompt/);
});

test("recursion guard refuses nested runs", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "x"], { AGY_COMPANION_DEPTH: "1" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /recursion guard/);
  assert.equal(agyCalls(sb).length, 0);
});

test("agy failure is reported and recorded", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "x"], { FAKE_AGY_EXIT: "3" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /status 3/);
  const result = companion(sb, ["result"]);
  assert.match(result.stdout, /failed/);
});

test("non-SUCCESS agy status is a failure", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "x"], { FAKE_AGY_STATUS: "ERROR" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /status ERROR/);
});

test("review of a dirty working tree renders structured findings", () => {
  const sb = makeSandbox();
  fs.writeFileSync(path.join(sb.repo, "app.js"), "export const add = (a, b) => a - b;\n");
  const res = companion(sb, ["review", "--wait"], { FAKE_AGY_RESPONSE: REVIEW_JSON });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /# Antigravity Review/);
  assert.match(res.stdout, /Verdict: needs-attention/);
  assert.match(res.stdout, /\[high\] Overflow \(app\.js:1\)/);
  const { args } = agyCalls(sb)[0];
  assert.deepEqual(args.slice(0, 2), ["--mode", "plan"]);
  assert.match(args.at(-1), /a - b/);
});

test("review with a clean tree and no base has nothing to review", () => {
  const sb = makeSandbox();
  const res = companion(sb, ["review", "--scope", "working-tree"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Nothing to review/);
});

test("adversarial decision review works outside git", () => {
  const sb = makeSandbox({ git: false });
  const res = companion(sb, ["adversarial-review", "--scope", "decision", "3-day log retention"], {
    FAKE_AGY_RESPONSE: `Sure:\n\`\`\`json\n${REVIEW_JSON}\n\`\`\``,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /# Antigravity Adversarial Review/);
  assert.match(agyCalls(sb)[0].args.at(-1), /3-day log retention/);
});

test("unstructured review output falls back to raw text", () => {
  const sb = makeSandbox({ git: false });
  const res = companion(sb, ["adversarial-review", "--scope", "decision", "x"], { FAKE_AGY_RESPONSE: "just prose" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /did not return structured JSON/);
  assert.match(res.stdout, /just prose/);
});

test("background job runs detached and result is retrievable", async () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "--background", "long job"], { FAKE_AGY_SLEEP_MS: "300", FAKE_AGY_RESPONSE: "done!" });
  assert.equal(res.status, 0, res.stderr);
  const jobId = res.stdout.match(/(task-[a-z0-9]+-[a-f0-9]+)/)[1];

  const finished = await waitFor(() => JSON.parse(companion(sb, ["status", jobId, "--json"]).stdout).status === "completed");
  assert.ok(finished, "background job did not complete");
  const result = companion(sb, ["result", jobId]);
  assert.match(result.stdout, /done!/);
  assert.match(result.stdout, /conv-123/);
});

test("cancel stops a running background job", async () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "--background", "slow"], { FAKE_AGY_SLEEP_MS: "30000" });
  const jobId = res.stdout.match(/(task-[a-z0-9]+-[a-f0-9]+)/)[1];
  await waitFor(() => JSON.parse(companion(sb, ["status", jobId, "--json"]).stdout).agyPid);

  const cancel = companion(sb, ["cancel", jobId]);
  assert.match(cancel.stdout, /Cancelled/);
  const job = JSON.parse(companion(sb, ["status", jobId, "--json"]).stdout);
  assert.equal(job.status, "cancelled");
  assert.ok(await waitFor(() => {
    try {
      process.kill(job.agyPid, 0);
      return false;
    } catch {
      return true;
    }
  }), "agy child still alive after cancel");
});

test("status table renders follow-ups", () => {
  const sb = makeSandbox();
  companion(sb, ["task", "x"]);
  const res = companion(sb, ["status"]);
  assert.match(res.stdout, /\| task-/);
  assert.match(res.stdout, /\/agy:result task-/);
});

function runHook(sb, input, extraEnv = {}) {
  return spawnSync(process.execPath, [STOP_HOOK], {
    cwd: sb.repo,
    env: { ...sb.env, ...extraEnv },
    input: JSON.stringify({ cwd: sb.repo, ...input }),
    encoding: "utf8",
  });
}

test("stop hook is a no-op when the gate is disabled", () => {
  const sb = makeSandbox();
  const res = runHook(sb, {});
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(agyCalls(sb).length, 0);
});

test("stop hook blocks on BLOCK and allows on ALLOW", () => {
  const sb = makeSandbox();
  companion(sb, ["setup", "--enable-review-gate"]);

  const blocked = runHook(sb, { last_assistant_message: "edited app.js" }, { FAKE_AGY_RESPONSE: "BLOCK: add returns a - b" });
  assert.equal(blocked.status, 0, blocked.stderr);
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /a - b/);

  const allowed = runHook(sb, {}, { FAKE_AGY_RESPONSE: "ALLOW: no edits" });
  assert.equal(allowed.stdout, "");
});

test("stop hook does not re-enter while stop_hook_active", () => {
  const sb = makeSandbox();
  companion(sb, ["setup", "--enable-review-gate"]);
  const res = runHook(sb, { stop_hook_active: true }, { FAKE_AGY_RESPONSE: "BLOCK: x" });
  assert.equal(res.stdout, "");
  assert.equal(agyCalls(sb).length, 0);
});

test("foreground run past --wait-timeout hands back the job and keeps running", async () => {
  const sb = makeSandbox();
  const res = companion(sb, ["task", "--wait-timeout", "1", "slow one"], { FAKE_AGY_SLEEP_MS: "2500", FAKE_AGY_RESPONSE: "late answer" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /still running after 1s/);
  const jobId = res.stdout.match(/(task-[a-z0-9]+-[a-f0-9]+)/)[1];
  assert.ok(await waitFor(() => JSON.parse(companion(sb, ["status", jobId, "--json"]).stdout).status === "completed"));
  assert.match(companion(sb, ["result", jobId]).stdout, /late answer/);
});

test("invalid --wait-timeout is rejected", () => {
  const sb = makeSandbox();
  assert.match(companion(sb, ["task", "--wait-timeout", "soon", "x"]).stderr, /Invalid --wait-timeout/);
});
