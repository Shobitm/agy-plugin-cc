# Changelog

## 0.2.0

Fixes from adversarial reviews by Antigravity and Codex, plus agy 1.4.7 changes.

- Read-only runs: `agy --mode plan --sandbox` (OS blocks shell writes) plus a before/after workspace fingerprint that fails the job and lists touched paths if agy's file tool wrote anything. Documented as detection, not prevention: agy has no headless way to deny its file-write tool.
- Write runs use agy's default mode; `--mode auto` is unavailable on some accounts (agy silently falls back). Opt in with `AGY_WRITE_MODE`.
- Prompt injection: repository content and briefs are wrapped in a random-boundary block marked as inert data; fences are sized so content cannot close them.
- Stop gate: turn-start baseline via a `UserPromptSubmit` hook; only files changed during the turn are reviewed and turns without edits are skipped; gate runs are their own `gate` kind (no longer hijack `--resume`, `/agy:result`, or job history); infrastructure failures fail open with a visible warning instead of blocking; timeouts sit below the hook limit and cancel the job; multi-line BLOCK reasons are kept.
- Jobs: one detached worker owns each job; locked read-modify-write; `cancelled` is terminal; cancel checks PID + start time before signalling and escalates SIGTERM to SIGKILL across the process group (`taskkill /T` on Windows); worker forwards termination to agy; stale jobs reconcile to failed; logs are pruned with their jobs.
- `agy` output: strict envelope parsing (unparseable is a failure, not a success); a grandchild holding stdio no longer hangs a run; hard run limit (`AGY_MAX_RUN_SECS`).
- Reviews: schema-validated JSON from the last valid candidate; symlinks/FIFOs never read; bounded untracked reads; `-z` path parsing (renames, non-ASCII); diffs fetched only when inlined; `--base` validated; a clean branch with focus text errors instead of silently becoming a decision review.
- Arguments: `/agy:status <job-id> --wait` works; mid-word apostrophes and backslash escapes are handled.
- `status --wait` exits 2 on timeout and validates `--timeout-ms`.
- Windows: PATHEXT binary lookup, `%LOCALAPPDATA%` state dir, tree kill; CI runs Windows.

## 0.1.1

- Fix: foreground `/agy:rescue` and `/agy:review --wait` could be killed by Claude Code's 2-minute Bash timeout and return nothing. Foreground runs now execute in a detached worker and wait up to 540s (`--wait-timeout`), then hand back the job ID; the subagent and commands set the Bash timeout to 10 minutes.

## 0.1.0

- Initial release: `/agy:setup`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`.
- `agy-rescue` subagent with runtime, prompting, and result-handling skills.
- Background jobs with per-workspace state, conversation resume, and cancellation.
- Optional stop-time review gate.
- Read-only runs use `agy --mode plan` without `--disable-slash-commands` (which silently disables plan mode in agy 1.4.x).
