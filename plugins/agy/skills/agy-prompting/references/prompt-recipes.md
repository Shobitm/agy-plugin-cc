# Antigravity Prompt Recipes

Use these recipes when assembling a task prompt for Antigravity (`agy`) via `agy-companion.mjs task`.

## 1. Read-Only Root-Cause Diagnosis

Use with `--read-only`:

```xml
<task>
Diagnose why <symptom or failing command> happens in <path or subsystem>.
Do not edit files; identify the exact root cause and the smallest safe fix.
</task>

<research_mode>
Trace the execution path from entrypoint to failure. Inspect the failing module, its immediate callers, and the relevant test or reproduction command.
</research_mode>

<grounding_guardrails>
Cite exact file paths and line numbers for every causal claim. Separate verified facts from hypotheses.
</grounding_guardrails>

<structured_output_contract>
Return:
1. Root cause
2. Evidence (`file:line` and reproduction output)
3. Recommended minimal fix
</structured_output_contract>
```

## 2. Minimal Bug Fix + Verification

Use with `--write`:

```xml
<task>
Fix <bug/failure> in <files or subsystem>.
Context from prior attempt: <1-3 bullets on what failed or was already ruled out>.
</task>

<default_follow_through_policy>
Proceed directly with the minimal safe fix without widening scope into unrelated refactors.
</default_follow_through_policy>

<completeness_contract>
Update any directly affected callers or unit tests required for the fix to hold.
</completeness_contract>

<verification_loop>
Run the narrowest relevant test or build check to verify the fix before finishing.
</verification_loop>

<compact_output_contract>
Summarize root cause, files changed, verification command + result, and any residual risk.
</compact_output_contract>
```

## 3. Narrow Verification / Second Opinion Check

Use with `--read-only`:

```xml
<task>
Verify whether the current changes in <files> safely resolve <issue> without breaking <contract or edge case>.
</task>

<grounding_guardrails>
Check actual callers, types, error paths, and tests in the workspace.
</grounding_guardrails>

<structured_output_contract>
State whether the fix holds, list any remaining failure modes with `file:line`, and recommend next steps.
</structured_output_contract>
```
