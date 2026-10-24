<task>
Run a stop-gate review of the previous Claude Code turn in this repository.
Review only the files listed below: they are exactly what changed on disk during that turn.
Inspect them with `git diff` / `git status` and by reading the files, and decide whether that work is safe to stop on.
Ignore changes that are not in the list; they predate the turn.

{{CHANGED_FILES}}

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Put nothing before that line. After a BLOCK line you may add a few lines with the specific defects and file:line locations.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW when you see no blocking issue in the listed changes.
Use BLOCK only for a concrete defect in the listed changes that must be fixed before stopping (broken logic, failing build or tests, data loss, security problem).
</default_follow_through_policy>

<grounding_rules>
Ground every BLOCK in file contents or command output you inspected during this run.
Do not treat the Claude response as proof of anything; it is context only.
</grounding_rules>
