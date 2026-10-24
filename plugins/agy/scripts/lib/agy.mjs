import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { commandFor, killTree, whichSync } from "./proc.mjs";

export const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_WRITE_MODES = new Set(["default", "auto", "accept-edits"]);

// Set on every agy child so a companion launched from inside Antigravity
// refuses to call agy again instead of recursing.
export const DEPTH_ENV = "AGY_COMPANION_DEPTH";

// Hard ceiling on a single agy run, independent of agy's own --print-timeout.
const DEFAULT_MAX_RUN_SECONDS = 2 * 60 * 60;

export function resolveAgyBinary() {
  if (process.env.AGY_BIN) {
    return process.env.AGY_BIN;
  }
  const localBin = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return whichSync("agy") ?? "agy";
}

export function getAgyAvailability() {
  const bin = resolveAgyBinary();
  const { file, args } = commandFor(bin, ["--version"]);
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      bin,
      version: null,
      detail: result.error ? result.error.message : (result.stderr || result.stdout || "").trim(),
    };
  }
  return { available: true, bin, version: (result.stdout || result.stderr || "").trim(), detail: null };
}

export function runAgySync(args, options = {}) {
  const { file, args: fullArgs } = commandFor(resolveAgyBinary(), args);
  return spawnSync(file, fullArgs, { encoding: "utf8", windowsHide: true, ...options });
}

export function assertNotNested() {
  if (process.env[DEPTH_ENV]) {
    throw new Error(
      "Refusing to call Antigravity from inside an Antigravity run (recursion guard). Answer the task directly instead."
    );
  }
}

// agy expands a leading "/" into its own slash commands/skills. We cannot pass
// --disable-slash-commands because it also silently disables --mode plan.
export function sanitizePrompt(prompt) {
  const text = String(prompt ?? "");
  return /^\s*\//.test(text) ? `Task: ${text.trim()}` : text;
}

export function validateEffort(effort) {
  if (effort && !VALID_EFFORTS.has(effort)) {
    throw new Error(`Invalid --effort "${effort}". Expected one of: ${[...VALID_EFFORTS].join(", ")}`);
  }
}

function resolveWriteMode() {
  const mode = process.env.AGY_WRITE_MODE || "default";
  if (!VALID_WRITE_MODES.has(mode)) {
    throw new Error(`Invalid AGY_WRITE_MODE "${mode}". Expected one of: ${[...VALID_WRITE_MODES].join(", ")}`);
  }
  return mode;
}

// Read-only: plan mode plus agy's OS sandbox, which blocks writes from shell
// commands. agy has no headless way to deny its own file-write tool (without
// auto-approval every shell command, even `git diff`, is denied and the run
// aborts), so the companion also fingerprints the workspace around read-only
// runs and fails any run that changed it.
//
// Write: agy's default mode. `--mode auto` is not available on every account
// (agy warns and falls back), so it is opt-in via AGY_WRITE_MODE.
export function buildAgyArgs({ write = false, model, effort, conversationId, continueLast = false, timeout, prompt }) {
  const args = [];
  if (write) {
    const mode = resolveWriteMode();
    if (mode !== "default") {
      args.push("--mode", mode);
    }
  } else {
    args.push("--mode", "plan", "--sandbox");
  }
  args.push("--dangerously-skip-permissions", "--output-format", "json");
  if (conversationId) {
    args.push("--conversation", conversationId);
  } else if (continueLast) {
    args.push("--continue");
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (timeout) {
    args.push("--print-timeout", timeout);
  }
  args.push("-p", sanitizePrompt(prompt));
  return args;
}

function asAgyPayload(value) {
  if (value && typeof value === "object" && "response" in value && "status" in value) {
    return {
      conversationId: value.conversation_id ?? null,
      status: String(value.status),
      response: String(value.response ?? "").trim(),
      durationSeconds: value.duration_seconds ?? null,
      usage: value.usage ?? null,
    };
  }
  return null;
}

// agy prints one JSON object with --output-format json, possibly after warning
// lines. Take the last line (or trailing block) that parses as that payload;
// anything else is a failure, never an implicit success.
export function parseAgyOutput(stdout) {
  const text = String(stdout ?? "").trim();
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim().startsWith("{")) {
      continue;
    }
    try {
      const payload = asAgyPayload(JSON.parse(lines.slice(i).join("\n")));
      if (payload) {
        return payload;
      }
    } catch {
      // try an earlier line
    }
  }
  return {
    conversationId: null,
    status: "UNPARSEABLE",
    response: text,
    durationSeconds: null,
    usage: null,
  };
}

export function collectWarnings(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^warning:/i.test(line));
}

export function runAgy(cwd, args, { onSpawn, maxRunSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveAgyBinary();
    const { file, args: fullArgs } = commandFor(bin, args);
    const child = spawn(file, fullArgs, {
      cwd,
      env: { ...process.env, [DEPTH_ENV]: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    onSpawn?.(child);

    const limit = Number(maxRunSeconds ?? process.env.AGY_MAX_RUN_SECS ?? DEFAULT_MAX_RUN_SECONDS);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, limit * 1000);

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to invoke Antigravity CLI (${bin}): ${err.message}. Run /agy:setup.`));
    });

    // Finish on "close" (all output flushed), but if a grandchild inherited
    // agy's stdio and keeps it open, stop waiting 2s after agy itself exits.
    let finished = false;
    let exitInfo = null;
    const finish = () => {
      if (finished || !exitInfo) {
        return;
      }
      finished = true;
      child.stdout.destroy();
      child.stderr.destroy();
      const { code, sig } = exitInfo;
      {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (timedOut) {
          reject(new Error(`Antigravity run exceeded the ${limit}s limit and was killed.`));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || "(no output)";
          reject(new Error(`Antigravity CLI exited with ${sig ? `signal ${sig}` : `status ${code}`}.\n${detail}`));
          return;
        }
        const parsed = parseAgyOutput(stdout);
        if (parsed.status !== "SUCCESS") {
          reject(new Error(`Antigravity run finished with status ${parsed.status}.\n${parsed.response || stderr.trim()}`));
          return;
        }
        resolve({ ...parsed, warnings: collectWarnings(stderr) });
      }
    };
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      exitInfo = { code, sig };
      setTimeout(finish, 2000).unref();
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      exitInfo = exitInfo ?? { code, sig };
      finish();
    });
  });
}
