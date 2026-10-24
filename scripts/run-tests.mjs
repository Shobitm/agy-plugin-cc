#!/usr/bin/env node
// Lists tests/*.test.mjs itself: Node 18 has no glob support and PowerShell
// does not expand globs for native commands.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
const files = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testsDir, name));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
