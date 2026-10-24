# Changelog

## 0.1.0

- Initial release: `/agy:setup`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`.
- `agy-rescue` subagent with runtime, prompting, and result-handling skills.
- Background jobs with per-workspace state, conversation resume, and cancellation.
- Optional stop-time review gate.
- Read-only runs use `agy --mode plan` without `--disable-slash-commands` (which silently disables plan mode in agy 1.4.x).
