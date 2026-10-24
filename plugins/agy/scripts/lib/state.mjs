import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveGitRoot } from "./git.mjs";
import { isSameProcess } from "./proc.mjs";

const MAX_USER_JOBS = 50;
const MAX_GATE_JOBS = 10;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const ACTIVE_STATUSES = new Set(["queued", "running"]);
// Internal stop-gate runs never appear in resume, default result/cancel, or
// the user job cap.
export const USER_KINDS = new Set(["task", "review", "adversarial-review"]);

export function resolveWorkspaceRoot(cwd) {
  return resolveGitRoot(cwd) || path.resolve(cwd);
}

function stateRoot() {
  if (process.env.AGY_COMPANION_STATE_DIR) {
    return process.env.AGY_COMPANION_STATE_DIR;
  }
  if (process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, "agy-plugin-cc");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "agy-plugin-cc", "state");
  }
  return path.join(os.homedir(), ".local", "state", "agy-plugin-cc");
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    // keep the unresolved path
  }
  const slug = (path.basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(stateRoot(), `${slug}-${hash}`);
}

function jobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Cross-process mutex: an exclusively-created lock file. Locks older than
// LOCK_STALE_MS belong to a crashed holder and are broken.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lock}`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function getConfig(cwd) {
  return { stopReviewGate: false, ...readJson(path.join(resolveStateDir(cwd), "config.json"), {}) };
}

export function setConfig(cwd, patch) {
  const file = path.join(resolveStateDir(cwd), "config.json");
  return withLock(file, () => {
    const next = { stopReviewGate: false, ...readJson(file, {}), ...patch };
    writeJsonAtomic(file, next);
    return next;
  });
}

const ID_PREFIX = { task: "task", review: "rev", "adversarial-review": "adv", gate: "gate" };

export function newJobId(kind) {
  return `${ID_PREFIX[kind] ?? "job"}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

function assertJobId(id) {
  if (!/^[a-z]+-[a-z0-9]+-[a-f0-9]+$/.test(String(id))) {
    throw new Error(`Invalid job id "${id}".`);
  }
}

export function jobFile(cwd, id) {
  assertJobId(id);
  return path.join(jobsDir(cwd), `${id}.json`);
}

export function jobLogFile(cwd, id) {
  assertJobId(id);
  return path.join(jobsDir(cwd), `${id}.log`);
}

export function saveJob(cwd, job) {
  const file = jobFile(cwd, job.id);
  withLock(file, () => writeJsonAtomic(file, { ...job, updatedAt: new Date().toISOString() }));
}

export function loadJob(cwd, id) {
  return readJson(jobFile(cwd, id), null);
}

// Locked read-modify-write. A job in a terminal state is never moved back:
// once cancelled, a late "completed" from the worker is dropped.
export function updateJob(cwd, id, patch, { allowFromTerminal = false } = {}) {
  const file = jobFile(cwd, id);
  return withLock(file, () => {
    const current = readJson(file, null);
    if (!current) {
      throw new Error(`Unknown job "${id}".`);
    }
    if (!allowFromTerminal && TERMINAL_STATUSES.has(current.status) && "status" in patch) {
      return current;
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    writeJsonAtomic(file, next);
    return next;
  });
}

// A job whose worker is gone (or whose PID now belongs to another process)
// without recording an outcome is reported as failed, not "running" forever.
function reconcile(cwd, job) {
  if (!ACTIVE_STATUSES.has(job.status)) {
    return job;
  }
  if (job.status === "queued" && !job.pid) {
    const age = Date.now() - Date.parse(job.createdAt);
    if (!(age > 60 * 1000)) {
      return job;
    }
  } else if (isSameProcess(job.pid, job.pidStart)) {
    return job;
  }
  return updateJob(cwd, job.id, {
    status: "failed",
    error: job.error ?? "Worker process exited without recording a result.",
    finishedAt: new Date().toISOString(),
  });
}

function removeJobFiles(dir, id) {
  for (const suffix of [".json", ".log", ".json.lock"]) {
    fs.rmSync(path.join(dir, `${id}${suffix}`), { force: true });
  }
}

export function listJobs(cwd, { includeGate = false } = {}) {
  const dir = jobsDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const jobs = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(dir, name), null))
    .filter(Boolean)
    .map((job) => reconcile(cwd, job))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const userJobs = jobs.filter((job) => USER_KINDS.has(job.kind));
  const gateJobs = jobs.filter((job) => !USER_KINDS.has(job.kind));
  for (const [list, cap] of [
    [userJobs, MAX_USER_JOBS],
    [gateJobs, MAX_GATE_JOBS],
  ]) {
    for (const stale of list.slice(cap)) {
      if (!ACTIVE_STATUSES.has(stale.status)) {
        removeJobFiles(dir, stale.id);
      }
    }
  }
  return (includeGate ? jobs : userJobs).filter((job) => fs.existsSync(path.join(dir, `${job.id}.json`)));
}

export function getJob(cwd, id) {
  const job = loadJob(cwd, id);
  return job ? reconcile(cwd, job) : null;
}

export function latestJob(cwd, predicate = () => true) {
  return listJobs(cwd).find(predicate) ?? null;
}

// Stop-gate turn baselines, keyed by Claude session id.
function baselineFile(cwd, sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDir(cwd), "baselines", `${safe}.json`);
}

export function saveBaseline(cwd, sessionId, baseline) {
  writeJsonAtomic(baselineFile(cwd, sessionId), baseline);
}

export function loadBaseline(cwd, sessionId) {
  return readJson(baselineFile(cwd, sessionId), null);
}
