import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IS_WINDOWS = process.platform === "win32";

// Resolve a bare command name against PATH (honouring PATHEXT on Windows).
export function whichSync(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command) ? command : null;
  }
  const exts = IS_WINDOWS ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of IS_WINDOWS ? ["", ...exts] : exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// Script files (used by tests and wrappers) run through the current node.
export function commandFor(bin, args) {
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    return { file: process.execPath, args: [bin, ...args] };
  }
  return { file: bin, args };
}

// A process identity that survives PID reuse: the PID plus its start time.
export function processStartTime(pid) {
  if (!pid) {
    return null;
  }
  const result = IS_WINDOWS
    ? spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
        { encoding: "utf8", timeout: 10000, windowsHide: true }
      )
    : spawnSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    return null;
  }
  const value = (result.stdout || "").trim();
  return value || null;
}

export function isSameProcess(pid, startTime) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: alive but another user's, so not one of ours.
    return false;
  }
  if (!startTime) {
    return true;
  }
  return processStartTime(pid) === startTime;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function signal(pid, sig, group) {
  try {
    process.kill(group ? -pid : pid, sig);
    return true;
  } catch {
    if (group) {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Terminate a process (and, on POSIX, its process group) with SIGTERM, then
// SIGKILL after a grace period. On Windows, taskkill /T kills the whole tree.
export function killTree(pid, { group = false, graceMs = 3000 } = {}) {
  if (!pid || !alive(pid)) {
    return false;
  }
  if (IS_WINDOWS) {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return res.status === 0;
  }
  signal(pid, "SIGTERM", group);
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) {
    sleepSync(100);
  }
  if (alive(pid)) {
    signal(pid, "SIGKILL", group);
  }
  return true;
}
