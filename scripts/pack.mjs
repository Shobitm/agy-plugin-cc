#!/usr/bin/env node
// Builds dist/agy-plugin-cc-<version>.tar.gz: the marketplace manifest plus
// the plugin directory, installable with `/plugin marketplace add <dir>`.
// Files are staged under a versioned folder because tar's path-rename flags
// differ between GNU tar, bsdtar and Windows tar.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `agy-plugin-cc-${version}`;
const dist = path.join(root, "dist");
const staging = path.join(dist, "staging");
const out = path.join(dist, `${name}.tar.gz`);

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, name), { recursive: true });
for (const entry of [".claude-plugin", "plugins", "README.md", "LICENSE", "NOTICE"]) {
  fs.cpSync(path.join(root, entry), path.join(staging, name, entry), {
    recursive: true,
    filter: (src) => path.basename(src) !== ".DS_Store",
  });
}

const result = spawnSync("tar", ["-czf", out, "-C", staging, name], { stdio: "inherit" });
fs.rmSync(staging, { recursive: true, force: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(out);
