import assert from "node:assert/strict";
import test from "node:test";

import { extractJsonObject, renderReviewMarkdown, sortFindings } from "../plugins/agy/scripts/lib/render.mjs";
import { buildAgyArgs, parseAgyOutput, sanitizePrompt } from "../plugins/agy/scripts/lib/agy.mjs";
import { parseGateAnswer } from "../plugins/agy/scripts/stop-review-gate-hook.mjs";

test("extracts JSON from fenced or prose-wrapped output", () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go: {"a":2} thanks'), { a: 2 });
  assert.equal(extractJsonObject("no json"), null);
});

test("sorts findings by severity then confidence", () => {
  const sorted = sortFindings([
    { severity: "low", confidence: 0.9 },
    { severity: "critical", confidence: 0.2 },
    { severity: "high", confidence: 0.4 },
    { severity: "high", confidence: 0.8 },
  ]);
  assert.deepEqual(sorted.map((f) => `${f.severity}:${f.confidence}`), ["critical:0.2", "high:0.8", "high:0.4", "low:0.9"]);
});

test("renders file locations and omits them for decisions", () => {
  const md = renderReviewMarkdown("T", "target", {
    verdict: "needs-attention",
    summary: "s",
    findings: [
      { severity: "high", title: "A", body: "b", file: "src/x.js", line_start: 3, line_end: 7, confidence: 0.7, recommendation: "r" },
      { severity: "low", title: "B", body: "b", file: "decision", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" },
    ],
    next_steps: ["do it"],
  });
  assert.match(md, /\[high\] A \(src\/x\.js:3-7\)/);
  assert.match(md, /\[low\] B · confidence/);
  assert.match(md, /## Next Steps\n\n- do it/);
});

test("read-only args use plan mode and never disable slash commands", () => {
  const args = buildAgyArgs({ write: false, prompt: "hi" });
  assert.deepEqual(args.slice(0, 2), ["--mode", "plan"]);
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.deepEqual(buildAgyArgs({ write: true, prompt: "hi" }).slice(0, 2), ["--mode", "auto"]);
});

test("conversation id wins over --continue", () => {
  const args = buildAgyArgs({ conversationId: "c1", continueLast: true, prompt: "x" });
  assert.ok(args.includes("--conversation"));
  assert.ok(!args.includes("--continue"));
});

test("leading slash prompts are neutralised", () => {
  assert.equal(sanitizePrompt("/agy-rescue do it"), "Task: /agy-rescue do it");
  assert.equal(sanitizePrompt("fix /tmp path"), "fix /tmp path");
});

test("parses agy json and tolerates warning prefixes", () => {
  const parsed = parseAgyOutput('warning: x\n{"conversation_id":"c","status":"SUCCESS","response":"OK\\n"}');
  assert.equal(parsed.conversationId, "c");
  assert.equal(parsed.response, "OK");
  assert.equal(parseAgyOutput("plain text").response, "plain text");
});

test("gate answers", () => {
  assert.equal(parseGateAnswer("ALLOW: nothing changed").ok, true);
  assert.equal(parseGateAnswer("BLOCK: null deref in x.js").ok, false);
  assert.match(parseGateAnswer("BLOCK: null deref").reason, /null deref/);
  assert.equal(parseGateAnswer("maybe").ok, false);
  assert.equal(parseGateAnswer("").ok, false);
});
