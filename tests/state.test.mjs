import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeSandbox } from "./helpers.mjs";

async function withState(sb, fn) {
  process.env.AGY_COMPANION_STATE_DIR = sb.env.AGY_COMPANION_STATE_DIR;
  const state = await import(`../plugins/agy/scripts/lib/state.mjs?${Date.now()}`);
  try {
    return await fn(state);
  } finally {
    delete process.env.AGY_COMPANION_STATE_DIR;
  }
}

test("terminal status cannot be overwritten", async () => {
  const sb = makeSandbox();
  await withState(sb, ({ saveJob, updateJob, loadJob }) => {
    saveJob(sb.repo, { id: "task-a-0001", kind: "task", status: "running", createdAt: new Date().toISOString() });
    updateJob(sb.repo, "task-a-0001", { status: "cancelled" });
    updateJob(sb.repo, "task-a-0001", { status: "completed", output: "late" });
    assert.equal(loadJob(sb.repo, "task-a-0001").status, "cancelled");
  });
});

test("pruning removes old job json and log files, gate jobs capped separately", async () => {
  const sb = makeSandbox();
  await withState(sb, ({ saveJob, listJobs, jobLogFile }) => {
    const t0 = Date.now();
    for (let i = 0; i < 55; i += 1) {
      const id = `task-${i.toString(36)}-${(1000 + i).toString(16)}`;
      saveJob(sb.repo, { id, kind: "task", status: "completed", createdAt: new Date(t0 + i * 1000).toISOString() });
      fs.writeFileSync(jobLogFile(sb.repo, id), "log");
    }
    for (let i = 0; i < 12; i += 1) {
      saveJob(sb.repo, { id: `gate-${i.toString(36)}-${(2000 + i).toString(16)}`, kind: "gate", status: "completed", createdAt: new Date(t0 + i).toISOString() });
    }
    assert.equal(listJobs(sb.repo).length, 50);
    assert.equal(listJobs(sb.repo, { includeGate: true }).length, 60);
    const jobsDir = path.dirname(jobLogFile(sb.repo, "task-0-3e8"));
    assert.equal(fs.readdirSync(jobsDir).filter((f) => f.endsWith(".log")).length, 50);
  });
});

test("concurrent updates from several processes do not lose fields", async () => {
  const sb = makeSandbox();
  await withState(sb, async ({ saveJob, loadJob }) => {
    saveJob(sb.repo, { id: "task-c-0001", kind: "task", status: "running", createdAt: new Date().toISOString() });
    const { spawn } = await import("node:child_process");
    const stateUrl = new URL("../plugins/agy/scripts/lib/state.mjs", import.meta.url).href;
    const writers = Array.from({ length: 8 }, (_, i) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", `const s = await import(${JSON.stringify(stateUrl)}); for (let j = 0; j < 20; j++) s.updateJob(${JSON.stringify(sb.repo)}, "task-c-0001", { ["f${i}_" + j]: j });`],
          { env: { ...process.env, AGY_COMPANION_STATE_DIR: sb.env.AGY_COMPANION_STATE_DIR }, stdio: "inherit" }
        );
        child.on("exit", (code) => resolve(code));
      })
    );
    assert.deepEqual(await Promise.all(writers), Array(8).fill(0), "a writer process crashed");
    const job = loadJob(sb.repo, "task-c-0001");
    assert.equal(Object.keys(job).filter((k) => /^f\d_\d+$/.test(k)).length, 160);
  });
});
