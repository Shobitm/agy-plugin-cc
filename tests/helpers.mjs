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

export function git(repo, ...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

export function makeSandbox({ git: withGit = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-test-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  if (withGit) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "app.js"), "export const add = (a, b) => a + b;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  }
  const env = {
    ...process.env,
    AGY_BIN: FAKE_AGY,
    AGY_COMPANION_STATE_DIR: path.join(dir, "state"),
    FAKE_AGY_LOG: path.join(dir, "agy.log"),
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FAKE_AGY_") && key !== "FAKE_AGY_LOG") {
      delete env[key];
    }
  }
  delete env.AGY_COMPANION_DEPTH;
  delete env.AGY_WRITE_MODE;
  delete env.AGY_FOREGROUND_WAIT_SECS;
  delete env.AGY_MAX_RUN_SECS;
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

export function runHook(sandbox, mode, input, extraEnv = {}) {
  return spawnSync(process.execPath, [STOP_HOOK, mode], {
    cwd: sandbox.repo,
    env: { ...sandbox.env, ...extraEnv },
    input: JSON.stringify({ cwd: sandbox.repo, session_id: "sess-1", ...input }),
    encoding: "utf8",
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

export function jobIdFrom(text) {
  return String(text).match(/((?:task|rev|adv|gate)-[a-z0-9]+-[a-f0-9]+)/)?.[1];
}

export function statusJson(sandbox, id) {
  return JSON.parse(companion(sandbox, ["status", id, "--json"]).stdout);
}

export async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
