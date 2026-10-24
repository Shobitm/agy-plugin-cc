---
description: Check whether the local Antigravity CLI (agy) is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup $ARGUMENTS
```

Output rules:
- Present the setup output to the user as-is.
- If Antigravity is not installed, point the user to https://antigravity.google and mention `AGY_BIN` for a non-standard install path. Do not try to install it yourself.
- If Antigravity is installed but not signed in, tell the user to run `!agy` once interactively to sign in, then rerun `/agy:setup`.
- If the review gate was enabled, warn that every Claude stop in this repository will now wait on an Antigravity review (often 1-3 minutes).
