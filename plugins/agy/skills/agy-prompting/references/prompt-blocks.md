# Antigravity Prompt Blocks

Copy only the blocks that control a real risk in the delegated task. Most `agy` rescue prompts need `<task>` plus 1-3 control blocks.

## Task Block

Always include a concrete task block:

```xml
<task>
State the concrete job, the relevant files or symptoms, and the desired end state.
</task>
```

## Answer-First Output Block

Use for read-only reviews, root-cause analysis, or architecture checks:

```xml
<structured_output_contract>
Lead with the direct finding or conclusion.
Then give the supporting file/line evidence.
Finish with the smallest safe next step.
</structured_output_contract>
```

## Compact Status Block

Use when Antigravity (`agy`) is editing code or running checks and the calling agent wants a clean handoff:

```xml
<compact_output_contract>
Keep the final response compact and structured:
1. root cause or key finding
2. files changed (if any)
3. verification run and outcome
4. remaining risks or open items
</compact_output_contract>
```

## Default Follow-Through Block

Use when Antigravity should execute rather than ask for confirmation on routine steps:

```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going unless a missing detail changes correctness, data safety, or external behavior.
</default_follow_through_policy>
```

## Completeness Block

Use when Antigravity must finish the full vertical slice rather than stop at the first edit:

```xml
<completeness_contract>
Do not stop at the first plausible patch. Trace callers, edge cases, and relevant tests until the task is complete and verified.
</completeness_contract>
```

## Verification Block

Use when the task changes behavior or diagnoses a failure:

```xml
<verification_loop>
Before finalizing, run the narrowest relevant verification command or test that proves the diagnosis or fix holds.
</verification_loop>
```

## Missing Context Gate

Use when you do not want Antigravity guessing past a real ambiguity:

```xml
<missing_context_gating>
Do not guess when required context is missing. Retrieve it with the available repo tools first, or state the exact blocker if it cannot be derived from the workspace.
</missing_context_gating>
```

## Bounded Research Block

Use when Antigravity could over-read the repo:

```xml
<research_mode>
Explore in three phases:
1. Broadly locate the relevant entrypoints or failing path.
2. Deeply inspect only the top candidate files.
3. Synthesize findings with exact file and line citations.
Stop expanding once additional files will not change the conclusion.
</research_mode>
```

## Grounding Block

Use when accuracy and evidence matter more than speed:

```xml
<grounding_guardrails>
Base every claim on files, command output, or git state you actually inspected. Label any remaining inference clearly as a hypothesis.
</grounding_guardrails>
```
