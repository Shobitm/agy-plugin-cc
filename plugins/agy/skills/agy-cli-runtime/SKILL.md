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
- `--write` → agy default mode (Antigravity may edit files and run commands; `AGY_WRITE_MODE` can select `auto` / `accept-edits`).
- `--read-only` (default without `--write`) → `agy --mode plan --sandbox`. Shell writes are blocked by the OS sandbox; file-tool writes are detected by a before/after workspace fingerprint and fail the job.
- Records every run as a job (`/agy:status`, `/agy:result`, `/agy:cancel`) and remembers the Antigravity conversation ID for `--resume-last`.
- Foreground runs wait up to 540s (`--wait-timeout <secs>`). If Antigravity is not done, the output starts with `STILL_RUNNING <job-id>` and the run continues; `result <job-id> --wait` waits again (exit code 2 = still running).
- `--background` returns a job ID immediately and nothing reports back when it finishes. The rescue subagent must not use it; background rescues run the subagent itself in the background.

Flags:
- `--write` | `--read-only`
- `--resume-last` (continue this workspace's last Antigravity task conversation) | `--fresh` | `--conversation <id>`
- `--model <id>` (see `agy models`), `--effort <low|medium|high|xhigh|max>`, `--timeout <duration e.g. 20m>`
- `--json`, `--cwd <dir>`

Execution rules:
- Exactly one `task` invocation per rescue handoff, followed by `result <job-id> --wait` calls only while the output says `STILL_RUNNING`. Every Bash call sets `timeout` to `600000`. The subagent is a forwarder, not an orchestrator.
- Prefer the helper over calling `agy` directly or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, or `cancel` from `agy:agy-rescue`.
- Leave `--model` and `--effort` unset unless the user explicitly asked.
- Return the stdout of the `task` command exactly as-is.
