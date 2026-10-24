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
- `--background` and `--wait` are execution flags. Keep them in the forwarded request; the subagent maps them onto the companion.
- If neither is present, the subagent decides (foreground for small bounded asks, background for open-ended work).
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
