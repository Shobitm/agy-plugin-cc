import assert from "node:assert/strict";
import test from "node:test";

import { normalizeArgv, parseCommandInput, splitRawArgumentString } from "../plugins/agy/scripts/lib/args.mjs";

test("splits a packed $ARGUMENTS string with quotes", () => {
  assert.deepEqual(splitRawArgumentString(`--base main --scope branch "race conditions" x`), [
    "--base",
    "main",
    "--scope",
    "branch",
    "race conditions",
    "x",
  ]);
});

test("normalizeArgv only unpacks single flag-led strings", () => {
  assert.deepEqual(normalizeArgv(["--wait --base main"]), ["--wait", "--base", "main"]);
  assert.deepEqual(normalizeArgv(["look at caching"]), ["look at caching"]);
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["--write", "fix it"]), ["--write", "fix it"]);
});

test("parses aliases, inline values and rejects unknown flags", () => {
  const { options, positionals } = parseCommandInput(["--read-only", "--effort=high", "fix", "it"], {
    valueFlags: ["effort"],
    booleanFlags: ["readOnly"],
    aliases: { "--read-only": "readOnly" },
  });
  assert.equal(options.readOnly, true);
  assert.equal(options.effort, "high");
  assert.deepEqual(positionals, ["fix", "it"]);
  assert.throws(() => parseCommandInput(["--nope"], {}), /Unknown option/);
});
