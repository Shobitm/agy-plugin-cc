---
description: Show active and recent Antigravity jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the output as one compact Markdown table. Keep job ID, kind, status, mode, elapsed, summary, and follow-up commands. No extra prose.

If the user passed a job ID:
- Present the full output. Do not summarize.
