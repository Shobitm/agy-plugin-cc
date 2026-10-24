import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const COMPANION = path.join(ROOT, "plugins/agy/scripts/agy-companion.mjs");
export const STOP_HOOK = path.join(ROOT, "plugins/agy/scripts/stop-review-gate-hook.mjs");
export const FAKE_AGY = path.join(here, "fake-agy.mjs");

export function makeSandbox({ git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-test-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  if (git) {
    const run = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "app.js"), "export const add = (a, b) => a + b;\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
  }
  const env = {
    ...process.env,
    AGY_BIN: FAKE_AGY,
    AGY_COMPANION_STATE_DIR: path.join(dir, "state"),
    FAKE_AGY_LOG: path.join(dir, "agy.log"),
  };
  delete env.AGY_COMPANION_DEPTH;
  return { dir, repo, env };
}

export function companion(sandbox, args, extraEnv = {}, input) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: sandbox.repo,
    env: { ...sandbox.env, ...extraEnv },
    encoding: "utf8",
    input,
  });
}

export function agyCalls(sandbox) {
  if (!fs.existsSync(sandbox.env.FAKE_AGY_LOG)) {
    return [];
  }
  return fs
    .readFileSync(sandbox.env.FAKE_AGY_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((call) => call.args.includes("-p"));
}

export async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
