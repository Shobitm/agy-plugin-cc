import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveGitRoot } from "./git.mjs";

const MAX_JOBS = 50;

export function resolveWorkspaceRoot(cwd) {
  return resolveGitRoot(cwd) || path.resolve(cwd);
}

function stateRoot() {
  if (process.env.AGY_COMPANION_STATE_DIR) {
    return process.env.AGY_COMPANION_STATE_DIR;
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agy-plugin-cc");
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
  const tmp = `${file}.${process.pid}.tmp`;
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

export function getConfig(cwd) {
  return { stopReviewGate: false, ...readJson(path.join(resolveStateDir(cwd), "config.json"), {}) };
}

export function setConfig(cwd, patch) {
  const next = { ...getConfig(cwd), ...patch };
  writeJsonAtomic(path.join(resolveStateDir(cwd), "config.json"), next);
  return next;
}

export function newJobId(kind) {
  const prefix = { task: "task", review: "rev", "adversarial-review": "adv" }[kind] ?? "job";
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

export function jobFile(cwd, id) {
  if (!/^[a-z]+-[a-z0-9]+-[a-f0-9]+$/.test(id)) {
    throw new Error(`Invalid job id "${id}".`);
  }
  return path.join(jobsDir(cwd), `${id}.json`);
}

export function saveJob(cwd, job) {
  writeJsonAtomic(jobFile(cwd, job.id), { ...job, updatedAt: new Date().toISOString() });
}

export function updateJob(cwd, id, patch) {
  const current = loadJob(cwd, id);
  if (!current) {
    throw new Error(`Unknown job "${id}".`);
  }
  const next = { ...current, ...patch };
  saveJob(cwd, next);
  return next;
}

export function loadJob(cwd, id) {
  return readJson(jobFile(cwd, id), null);
}

export function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// A job whose worker died without recording an outcome is reported as failed
// rather than "running" forever.
function reconcile(cwd, job) {
  if ((job.status === "running" || job.status === "queued") && job.pid && !isProcessAlive(job.pid)) {
    return updateJob(cwd, job.id, {
      status: "failed",
      error: job.error ?? "Worker process exited without recording a result.",
      finishedAt: job.finishedAt ?? new Date().toISOString(),
    });
  }
  return job;
}

export function listJobs(cwd) {
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

  for (const stale of jobs.slice(MAX_JOBS)) {
    if (stale.status !== "running" && stale.status !== "queued") {
      fs.rmSync(path.join(dir, `${stale.id}.json`), { force: true });
    }
  }
  return jobs.slice(0, MAX_JOBS);
}

export function getJob(cwd, id) {
  const job = loadJob(cwd, id);
  return job ? reconcile(cwd, job) : null;
}

export function latestJob(cwd, predicate = () => true) {
  return listJobs(cwd).find(predicate) ?? null;
}
