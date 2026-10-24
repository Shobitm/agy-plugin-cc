# Changelog

## 0.1.1

- Fix: foreground `/agy:rescue` and `/agy:review --wait` could be killed by Claude Code's 2-minute Bash timeout and return nothing. Foreground runs now execute in a detached worker and wait up to 540s (`--wait-timeout`), then hand back the job ID; the subagent and commands set the Bash timeout to 10 minutes.

## 0.1.0

- Initial release: `/agy:setup`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`.
- `agy-rescue` subagent with runtime, prompting, and result-handling skills.
- Background jobs with per-workspace state, conversation resume, and cancellation.
- Optional stop-time review gate.
- Read-only runs use `agy --mode plan` without `--disable-slash-commands` (which silently disables plan mode in agy 1.4.x).
