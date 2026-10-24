---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Antigravity through the agy-rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--read-only|--write] [--model <model>] [--effort <low|medium|high|xhigh|max>] [what Antigravity should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(agy:agy-rescue)` or `Skill(agy:rescue)` (that re-enters this command).
The final user-visible response must be Antigravity's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- If the request includes `--background`, run the `agy:agy-rescue` subagent in the background (Agent tool `run_in_background: true` where the tool offers it). You are notified when it finishes; then relay its output verbatim. Do not tell the subagent to detach.
- If the request includes `--wait`, or neither flag, run the subagent in the foreground.
- `--background` and `--wait` are Claude-side execution flags. Strip them from the forwarded request.
- If the request includes `--resume` or `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, check for a resumable Antigravity conversation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` exactly once:
  - `Continue current Antigravity conversation`
  - `Start a new Antigravity conversation`
- Put `(Recommended)` on Continue when the user is clearly following up ("continue", "keep going", "apply the top fix", "dig deeper"); otherwise on Start new.
- Add `--resume` or `--fresh` to the forwarded request accordingly.
- If it reports `available: false`, do not ask.

Operating rules:
- The subagent is a thin forwarder: one `Bash` call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task ...`, stdout returned as-is.
- Return the companion stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Leave `--model` and `--effort` unset unless the user asked for them.
- If the companion reports that agy is missing or not signed in, tell the user to run `/agy:setup`.
- If the user gave no request, ask what Antigravity should investigate or fix.
