#!/usr/bin/env node
// Builds dist/agy-plugin-cc-<version>.tar.gz: the marketplace manifest plus
// the plugin directory, installable with `/plugin marketplace add <dir>`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `agy-plugin-cc-${version}`;
const out = path.join(root, "dist", `${name}.tar.gz`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const files = [".claude-plugin", "plugins", "README.md", "LICENSE", "NOTICE"];
const isGnuTar = /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");
const rename = isGnuTar ? [`--transform=s,^,${name}/,`] : ["-s", `,^,${name}/,`];
const result = spawnSync("tar", ["-czf", out, "--exclude", ".DS_Store", ...rename, ...files], { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(out);
