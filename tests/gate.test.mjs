import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { agyCalls, companion, makeSandbox, runHook } from "./helpers.mjs";

function enable(sb) {
  companion(sb, ["setup", "--enable-review-gate"]);
}

test("gate disabled: no agy call", () => {
  const sb = makeSandbox();
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "changed\n");
  const res = runHook(sb, "stop", {});
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(agyCalls(sb).length, 0);
});

test("turn without edits is skipped even with pre-existing dirty files", () => {
  const sb = makeSandbox();
  enable(sb);
  fs.writeFileSync(path.join(sb.repo, "app.js"), "dirty before the turn\n");
  runHook(sb, "baseline", {});
  const res = runHook(sb, "stop", { last_assistant_message: "just answered a question" });
  assert.equal(res.stdout, "");
  assert.equal(agyCalls(sb).length, 0);
});

test("only files changed during the turn are sent to the gate", () => {
  const sb = makeSandbox();
  enable(sb);
  fs.writeFileSync(path.join(sb.repo, "old.txt"), "pre-existing\n");
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "export const add = (a, b) => a - b;\n");
  const res = runHook(sb, "stop", { last_assistant_message: "edited app.js" }, { FAKE_AGY_RESPONSE: "ALLOW: ok" });
  assert.equal(res.stdout, "");
  const prompt = agyCalls(sb)[0].args.at(-1);
  assert.match(prompt, /- app\.js/);
  assert.doesNotMatch(prompt, /- old\.txt/);
  assert.match(prompt, /<<<REPO_DATA_/);
});

test("BLOCK keeps the full multi-line reason", () => {
  const sb = makeSandbox();
  enable(sb);
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "broken\n");
  const res = runHook(sb, "stop", {}, { FAKE_AGY_RESPONSE: "BLOCK: add is broken\n- app.js:1 returns a - b" });
  const decision = JSON.parse(res.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /app\.js:1 returns a - b/);
});

test("agy failure fails open with a visible warning, never blocks", () => {
  const sb = makeSandbox();
  enable(sb);
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "x\n");
  for (const env of [{ FAKE_AGY_EXIT: "1" }, { FAKE_AGY_RESPONSE: "I think it is fine" }, { FAKE_AGY_STATUS: "ERROR" }]) {
    const out = JSON.parse(runHook(sb, "stop", {}, env).stdout);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /stop-time review skipped/);
  }
});

test("gate runs do not touch the user's resume candidate", () => {
  const sb = makeSandbox();
  enable(sb);
  companion(sb, ["task", "user work"], { FAKE_AGY_CONVERSATION: "conv-user" });
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "x\n");
  runHook(sb, "stop", {}, { FAKE_AGY_RESPONSE: "ALLOW: ok", FAKE_AGY_CONVERSATION: "conv-gate" });
  assert.equal(JSON.parse(companion(sb, ["task-resume-candidate", "--json"]).stdout).conversationId, "conv-user");
});

test("stop_hook_active and nested runs skip the gate", () => {
  const sb = makeSandbox();
  enable(sb);
  runHook(sb, "baseline", {});
  fs.writeFileSync(path.join(sb.repo, "app.js"), "x\n");
  assert.equal(runHook(sb, "stop", { stop_hook_active: true }, { FAKE_AGY_RESPONSE: "BLOCK: x" }).stdout, "");
  assert.equal(runHook(sb, "stop", {}, { AGY_COMPANION_DEPTH: "1", FAKE_AGY_RESPONSE: "BLOCK: x" }).stdout, "");
  assert.equal(agyCalls(sb).length, 0);
});
