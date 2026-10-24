---
description: Show the stored final output for a finished Antigravity job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Present the full output to the user. Do not summarize or condense it. Preserve the job ID, status, Antigravity conversation ID, verdict, findings, file paths and line numbers, next steps, and any error text exactly as reported.
