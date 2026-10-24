---
description: Run an Antigravity code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only Antigravity code review of the current changes.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Antigravity's output verbatim.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in the background.
- If the arguments include `--scope decision` or `--prompt-file`, there is no diff to size: recommend background.
- Otherwise, estimate the review size before asking:
  - For working-tree review, run `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`.
  - For base-branch review, run `git diff --shortstat <base>...HEAD`.
  - Treat untracked files as reviewable work even when `git diff --shortstat` is empty.
  - Recommend waiting only when the review is clearly tiny (roughly 1-2 files). Antigravity runs take at least a minute, so in every other case recommend background.
- Then use `AskUserQuestion` exactly once with two options, recommended option first with `(Recommended)` appended:
  - `Wait for results`
  - `Run in background`
- Add `--wait` or `--background` to the arguments to match the choice.

Argument handling:
- Preserve the user's arguments and focus text exactly. Do not rewrite or soften them.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --wait $ARGUMENTS
```
- Return stdout verbatim. Do not paraphrase, summarize, or add commentary. Do not fix anything it reports.

Background flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --background $ARGUMENTS
```
- Return the job-started message. Tell the user: "Antigravity review started in the background. Check `/agy:status` for progress."
