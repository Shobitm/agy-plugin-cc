import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./helpers.mjs";

const PLUGIN = path.join(ROOT, "plugins/agy");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file} has no frontmatter`);
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => /^[a-z-]+:/.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()])
  );
}

test("versions agree across manifests", () => {
  const market = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
  const plugin = readJson(path.join(PLUGIN, ".claude-plugin/plugin.json"));
  const pkg = readJson(path.join(ROOT, "package.json"));
  assert.equal(market.plugins[0].version, plugin.version);
  assert.equal(market.metadata.version, plugin.version);
  assert.equal(pkg.version, plugin.version);
  assert.equal(market.plugins[0].name, plugin.name);
});

test("every command, agent and skill has a description", () => {
  const files = [
    ...fs.readdirSync(path.join(PLUGIN, "commands")).map((f) => path.join(PLUGIN, "commands", f)),
    ...fs.readdirSync(path.join(PLUGIN, "agents")).map((f) => path.join(PLUGIN, "agents", f)),
    ...fs.readdirSync(path.join(PLUGIN, "skills")).map((d) => path.join(PLUGIN, "skills", d, "SKILL.md")),
  ];
  for (const file of files) {
    assert.ok(frontmatter(file).description, `${file} missing description`);
  }
});

test("commands reference only existing companion subcommands", () => {
  const known = new Set(["setup", "task", "review", "adversarial-review", "status", "result", "cancel", "task-resume-candidate"]);
  for (const file of fs.readdirSync(path.join(PLUGIN, "commands"))) {
    const text = fs.readFileSync(path.join(PLUGIN, "commands", file), "utf8");
    for (const [, sub] of text.matchAll(/agy-companion\.mjs" ([a-z-]+)/g)) {
      assert.ok(known.has(sub), `${file} uses unknown subcommand ${sub}`);
    }
  }
});

test("no machine-specific paths are shipped", () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );
  for (const file of walk(PLUGIN)) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\/Users\/|\/home\/[a-z]/, file);
  }
});
