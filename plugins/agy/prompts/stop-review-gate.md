<task>
Run a stop-gate review of the previous Claude Code turn in this repository.
Only review work from that turn, and only if it made direct code or config edits.
Status updates, summaries, setup checks, review results, or output from /agy:* commands do not count as edits.
If the previous turn made no edits, answer ALLOW immediately and do no further work.
Otherwise, inspect `git status` and `git diff` and decide whether that work is safe to stop on.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Put nothing before that line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW when there were no edits or you see no blocking issue.
Use BLOCK only for a concrete defect in the previous turn's edits that must be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Do not treat the Claude response as proof that edits happened; verify from repository state.
Do not block on older edits that the previous turn did not make.
</grounding_rules>
