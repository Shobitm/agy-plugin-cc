---
name: agy-result-handling
description: Internal guidance for presenting Antigravity helper output back to the user
user-invocable: false
---

# Antigravity Result Handling

When the helper returns Antigravity output:
- Preserve the verdict, summary, findings, and next-steps structure.
- For review output, keep findings ordered by severity, with file paths and line numbers exactly as reported.
- Preserve evidence boundaries: if Antigravity marked something as an inference, hypothesis, or open question, keep that distinction.
- If there are no findings, say so explicitly and keep the residual-risk note brief.
- If Antigravity made edits, say so and list the touched files when reported. Do not silently overwrite or undo them.
- For `agy:agy-rescue`, do not turn a failed or incomplete Antigravity run into a Claude-side implementation attempt. Report the failure and stop.
- If Antigravity was never successfully invoked, do not generate a substitute answer.
- CRITICAL: after presenting review findings, STOP. Do not change code. Ask the user which findings, if any, they want fixed before touching a file.
- If the helper reports malformed output or a failed run, include the most actionable error lines and stop.
- If the helper reports that setup or sign-in is required, direct the user to `/agy:setup`.
