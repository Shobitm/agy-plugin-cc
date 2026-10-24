#!/usr/bin/env node
// Stand-in for the agy CLI. Behaviour is driven by FAKE_AGY_* env vars and
// every invocation's argv is appended to FAKE_AGY_LOG as one JSON line.
import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) {
  fs.appendFileSync(
    process.env.FAKE_AGY_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, depth: process.env.AGY_COMPANION_DEPTH ?? null })}\n`
  );
}
if (args[0] === "--version") {
  process.stdout.write("1.4.7\n");
  process.exit(0);
}
if (args[0] === "models") {
  if (process.env.FAKE_AGY_UNAUTH) {
    process.stderr.write("not signed in\n");
    process.exit(1);
  }
  process.stdout.write("gemini-test\tGemini Test\n");
  process.exit(0);
}

if (process.env.FAKE_AGY_WARN) {
  process.stderr.write(`warning: ${process.env.FAKE_AGY_WARN}\n`);
}
if (process.env.FAKE_AGY_WRITE_FILE) {
  fs.writeFileSync(process.env.FAKE_AGY_WRITE_FILE, "written by fake agy\n");
}
if (process.env.FAKE_AGY_GRANDCHILD) {
  // A long-lived child that inherits our stdout/stderr.
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
}

const sleepMs = Number(process.env.FAKE_AGY_SLEEP_MS ?? 0);
const finish = () => {
  if (process.env.FAKE_AGY_EXIT) {
    process.stderr.write("boom\n");
    process.exit(Number(process.env.FAKE_AGY_EXIT));
  }
  if (process.env.FAKE_AGY_RAW_STDOUT != null) {
    process.stdout.write(process.env.FAKE_AGY_RAW_STDOUT);
    process.exit(0);
  }
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const response = process.env.FAKE_AGY_RESPONSE ?? `echo: ${prompt.split("\n")[0]}`;
  if (process.env.FAKE_AGY_STDOUT_PREFIX) {
    process.stdout.write(`${process.env.FAKE_AGY_STDOUT_PREFIX}\n`);
  }
  process.stdout.write(
    JSON.stringify({
      conversation_id: process.env.FAKE_AGY_CONVERSATION ?? "conv-123",
      status: process.env.FAKE_AGY_STATUS ?? "SUCCESS",
      response,
      duration_seconds: 0.01,
      num_turns: 1,
    })
  );
  process.exit(0);
};
sleepMs ? setTimeout(finish, sleepMs) : finish();
