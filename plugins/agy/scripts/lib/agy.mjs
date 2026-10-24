import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Set on every agy child so a companion launched from inside Antigravity
// refuses to call agy again instead of recursing.
export const DEPTH_ENV = "AGY_COMPANION_DEPTH";

export function resolveAgyBinary() {
  if (process.env.AGY_BIN) {
    return process.env.AGY_BIN;
  }
  const localBin = path.join(os.homedir(), ".local", "bin", "agy");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return "agy";
}

export function getAgyAvailability() {
  const bin = resolveAgyBinary();
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
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

export function assertNotNested() {
  if (process.env[DEPTH_ENV]) {
    throw new Error(
      "Refusing to call Antigravity from inside an Antigravity run (recursion guard). Answer the task directly instead."
    );
  }
}

// agy expands a leading "/" into its own slash commands/skills. We cannot pass
// --disable-slash-commands because it also silently disables --mode plan,
// which is what keeps read-only runs read-only.
export function sanitizePrompt(prompt) {
  const text = String(prompt ?? "");
  return /^\s*\//.test(text) ? `Task: ${text.trim()}` : text;
}

export function validateEffort(effort) {
  if (effort && !VALID_EFFORTS.has(effort)) {
    throw new Error(`Invalid --effort "${effort}". Expected one of: ${[...VALID_EFFORTS].join(", ")}`);
  }
}

export function buildAgyArgs({ write = false, model, effort, conversationId, continueLast = false, timeout, prompt }) {
  const args = ["--mode", write ? "auto" : "plan", "--dangerously-skip-permissions", "--output-format", "json"];
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

export function parseAgyOutput(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const payload = JSON.parse(text.slice(start));
      if (payload && typeof payload === "object" && "response" in payload) {
        return {
          conversationId: payload.conversation_id ?? null,
          status: payload.status ?? "UNKNOWN",
          response: String(payload.response ?? "").trim(),
          durationSeconds: payload.duration_seconds ?? null,
          usage: payload.usage ?? null,
        };
      }
    } catch {
      // fall through to plain text
    }
  }
  return { conversationId: null, status: text ? "SUCCESS" : "EMPTY", response: text, durationSeconds: null, usage: null };
}

export function runAgy(cwd, args, { onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveAgyBinary();
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, [DEPTH_ENV]: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (err) => {
      reject(new Error(`Failed to invoke Antigravity CLI (${bin}): ${err.message}. Run /agy:setup.`));
    });

    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || "(no output)";
        reject(new Error(`Antigravity CLI exited with ${signal ? `signal ${signal}` : `status ${code}`}.\n${detail}`));
        return;
      }
      const parsed = parseAgyOutput(stdout);
      if (parsed.status !== "SUCCESS") {
        reject(new Error(`Antigravity run finished with status ${parsed.status}.\n${parsed.response || stderr.trim()}`));
        return;
      }
      resolve({ ...parsed, stderr });
    });
  });
}
