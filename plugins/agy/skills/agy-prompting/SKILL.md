---
name: agy-prompting
description: Internal guidance for composing compact, high-signal prompts for Google Antigravity (agy) rescue and review tasks
user-invocable: false
---

# Prompting Antigravity

Use when shaping a task prompt for the `agy-companion.mjs task` helper.

Shape:
1. A `<task>` block with the exact objective, symptom, or failing command and the desired end state.
2. 1-3 bullets of context: relevant files, the exact error output, and what was already tried or ruled out.
3. 1-3 control blocks that address a real risk in this task (verification, completeness, output shape, grounding).

Defaults:
- Diagnosis / second opinion → `--read-only` with `<research_mode>`, `<grounding_guardrails>`, `<structured_output_contract>`.
- Fix → `--write` with `<default_follow_through_policy>`, `<verification_loop>`, `<compact_output_contract>`.

References:
- [prompt-blocks.md](references/prompt-blocks.md) — reusable XML control blocks.
- [prompt-recipes.md](references/prompt-recipes.md) — ready templates for diagnosis, minimal fix, and verification.
- [prompt-antipatterns.md](references/prompt-antipatterns.md) — mistakes to avoid.

Never start a prompt with `/` and never ask Antigravity to call agy or an agy-* skill.
