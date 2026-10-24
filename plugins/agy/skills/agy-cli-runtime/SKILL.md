---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# Antigravity Runtime

Use this skill only inside the `agy:agy-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task [flags] "<prompt>"`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task [flags] --prompt-file <path>`

What the helper does:
- Runs `agy -p` non-interactively with `--output-format json` and `--dangerously-skip-permissions`.
- `--write` → `agy --mode auto` (Antigravity may edit files and run commands).
- `--read-only` (default without `--write`) → `agy --mode plan` (no edits).
- Records every run as a job (`/agy:status`, `/agy:result`, `/agy:cancel`) and remembers the Antigravity conversation ID for `--resume-last`.
- `--background` detaches the run and returns a job ID immediately.

Flags:
- `--write` | `--read-only`
- `--resume-last` (continue this workspace's last Antigravity task conversation) | `--fresh` | `--conversation <id>`
- `--model <id>` (see `agy models`), `--effort <low|medium|high|xhigh|max>`, `--timeout <duration e.g. 20m>`
- `--background`, `--json`, `--cwd <dir>`

Execution rules:
- Exactly one `task` invocation per rescue handoff. The subagent is a forwarder, not an orchestrator.
- Prefer the helper over calling `agy` directly or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `agy:agy-rescue`.
- Leave `--model` and `--effort` unset unless the user explicitly asked.
- Return the stdout of the `task` command exactly as-is.
