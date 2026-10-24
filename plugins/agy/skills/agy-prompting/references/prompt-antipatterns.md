# Antigravity Prompt Antipatterns

Avoid these mistakes when constructing prompts for Antigravity (`agy`):

1. **Vague open-ended requests ("take a look at the repo and fix things")**
   - Always name the concrete symptom, error output, or target files, and specify whether the task is diagnosis (`--read-only`) or implementation (`--write`).
2. **Dumping full conversation transcripts into `<task>`**
   - Summarize only the 2-4 high-signal facts: the failing command/error, files involved, and approaches already ruled out.
3. **Contradictory scope instructions**
   - Do not ask for a "minimal surgical fix" while also asking for a broad architectural redesign in the same turn.
4. **Over-stacking XML blocks**
   - Use `<task>` plus 1-3 relevant control blocks (`<verification_loop>`, `<completeness_contract>`, `<structured_output_contract>`). Too many boilerplate blocks dilute focus.
5. **Recursive skill triggers**
   - Never ask `agy` to run `/agy-rescue` or `/agy-adversarial-review` inside its prompt. The companion rewrites a leading `/` (agy would expand it as a slash command) and sets a recursion guard env var, but keep prompts free of slash-command text anyway.
