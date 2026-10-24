# Antigravity plugin for Claude Code

Use [Google Antigravity](https://antigravity.google) (`agy`) from inside Claude Code to review code, challenge a design or policy decision, or hand off a stuck task — and get an independent second model's opinion without leaving your session.

Modelled on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), rebuilt around the `agy` CLI.

## What you get

| Command | What it does |
|---|---|
| `/agy:review` | Read-only code review of your working tree or branch |
| `/agy:adversarial-review` | Challenge review of the approach, assumptions, and failure modes — works on a diff **or** a design/ops/retention decision with no diff |
| `/agy:rescue` | Delegate an investigation or fix to Antigravity via the `agy-rescue` subagent |
| `/agy:status` · `/agy:result` · `/agy:cancel` | Manage background jobs |
| `/agy:setup` | Check `agy` is installed and signed in; toggle the stop-time review gate |

Plus:
- `agy:agy-rescue` subagent that Claude can call on its own when it is stuck.
- Background jobs with per-repo history and Antigravity conversation resume.
- Optional stop-time review gate: Antigravity reviews each Claude turn's edits before Claude stops.

## Requirements

- Google Antigravity with the `agy` CLI on `PATH` (or at `~/.local/bin/agy`, or set `AGY_BIN`). Tested with agy 1.4.x.
- Signed in to Antigravity (run `agy` once interactively).
- Node.js 18.18+ and git. macOS, Linux and Windows (CI runs all three).

Usage counts against your Antigravity plan.

## Install

From GitHub:

```bash
/plugin marketplace add Shobitm/agy-plugin-cc
/plugin install agy@agy-plugin-cc
/reload-plugins
/agy:setup
```

From a release tarball (offline / air-gapped):

```bash
tar -xzf agy-plugin-cc-0.2.3.tar.gz -C ~/plugins
# in Claude Code:
/plugin marketplace add ~/plugins/agy-plugin-cc-0.2.3
/plugin install agy@agy-plugin-cc
/reload-plugins
/agy:setup
```

Build the tarball yourself with `npm run pack` (writes `dist/agy-plugin-cc-<version>.tar.gz`). Tagged releases attach it automatically.

## Usage

### `/agy:review`

```bash
/agy:review                      # working tree if dirty, else branch vs default branch
/agy:review --base main          # committed changes since main
/agy:review --background         # run detached; check /agy:status
```

Read-only. Claude asks whether to wait or run in the background unless you pass `--wait` / `--background`.

### `/agy:adversarial-review`

```bash
/agy:adversarial-review challenge the retry and idempotency design
/agy:adversarial-review --base main look for race conditions
/agy:adversarial-review --scope decision "Move logs to 3-day retention to cut cost"
/agy:adversarial-review --scope decision --prompt-file docs/proposal.md
```

Returns a verdict (`approve` / `needs-attention`) and severity-ordered findings with file:line and recommendations. Claude presents it verbatim and does not auto-fix.

### `/agy:rescue`

```bash
/agy:rescue the integration tests fail with ECONNRESET after the pool change — find out why
/agy:rescue --read-only second opinion: is this lock ordering deadlock-free?
/agy:rescue --background migrate the config loader to the new schema and make tests pass
/agy:rescue --resume apply the top fix
/agy:rescue --effort high --model gemini-3.1-pro-high ...
```

- Writes by default (agy's default mode); `--read-only` uses `agy --mode plan --sandbox` with an integrity check (see below).
- If a previous rescue conversation exists in this repo, Claude asks whether to continue it or start fresh.
- `agy models` lists model IDs.

### Jobs

```bash
/agy:status                 # table of recent jobs in this repo
/agy:status <job-id> --wait # block until it finishes
/agy:result [job-id]        # full output of the latest (or given) finished job
/agy:cancel [job-id]        # stop a running job
```

### Stop-time review gate

```bash
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
```

When enabled for a repo, each time Claude is about to stop after a turn that changed files, Antigravity reviews those files and can block the stop with a reason. Turns with no edits are skipped. Each reviewed turn adds a minute or more — leave it off unless you want it.

## How it works

Everything goes through `plugins/agy/scripts/agy-companion.mjs`, which runs agy headless:

```text
read-only:  agy --mode plan --sandbox --dangerously-skip-permissions --output-format json -p "<prompt>"
write:      agy [--mode $AGY_WRITE_MODE] --dangerously-skip-permissions --output-format json -p "<prompt>"
```

**What "read-only" does and does not guarantee** (measured against agy 1.4.7):
- `--sandbox` makes the OS block writes from shell commands (`touch: Operation not permitted`).
- agy's own file-write tool is *not* blocked by `--mode plan` or `--sandbox`, and headless agy cannot prompt: without `--dangerously-skip-permissions` every shell command (even `git diff`) is auto-denied and the run aborts with no output.
- So the companion fingerprints the workspace before and after each read-only run (git: HEAD plus content hashes of every changed/untracked file; otherwise size+mtime of files). Any difference fails the job and lists the touched paths. This **detects** writes; it does not prevent them. Use git to revert.
- Repository content in review prompts (diffs, commit messages, untracked files, your brief) is wrapped in a random-boundary block the prompt marks as inert data, and fences are sized so content cannot close them. This raises the bar for prompt injection; it is not a guarantee.
- `--disable-slash-commands` is not used: it silently disables `--mode plan`. A leading `/` in a prompt is neutralised instead.

**Jobs.** Every run, foreground or background, executes in a detached worker that owns its job record. Foreground commands wait up to 540s (`--wait-timeout`), then hand back the job ID, so Claude Code's Bash timeout can't kill a run mid-flight. Job records are updated under a lock file; `cancelled` is terminal (a late result can't overwrite it). Cancel only signals a process whose PID *and* start time still match, then escalates SIGTERM → SIGKILL across the worker's process group (`taskkill /T` on Windows).

**Stop gate.** A `UserPromptSubmit` hook fingerprints the workspace at the start of each turn; the `Stop` hook reviews only files that changed during the turn and skips turns with no edits. Gate runs are recorded as their own `gate` kind, so they never hijack `--resume`, `/agy:result`, or the job history. If agy fails, times out (780s, then the job is cancelled), or answers neither ALLOW nor BLOCK, the stop goes through with a visible warning instead of looping.

**Output.** agy's JSON envelope is parsed strictly (anything unparseable is a failure, never a silent success). Review JSON is taken from the last valid candidate in the output and validated against `schemas/review-output.schema.json`.

`AGY_COMPANION_DEPTH` is set on every agy child, so a companion launched from inside Antigravity refuses to recurse. State lives in `$XDG_STATE_HOME/agy-plugin-cc` (default `~/.local/state/agy-plugin-cc`, `%LOCALAPPDATA%\agy-plugin-cc\state` on Windows), one folder per repo; override with `AGY_COMPANION_STATE_DIR`.

### Using it from Codex or other agents

The companion is a plain Node CLI, so any agent can use it:

```bash
node plugins/agy/scripts/agy-companion.mjs adversarial-review --scope decision "..."
node plugins/agy/scripts/agy-companion.mjs task --read-only --prompt-file brief.md
node plugins/agy/scripts/agy-companion.mjs --help
```

Prompt guidance for delegated tasks is in `plugins/agy/skills/agy-prompting/`.

When calling it from another agent, use a long shell timeout. The job ID is printed to stderr as soon as a run starts (`agy job <id> started`); if the output starts with `STILL_RUNNING <id>` or your shell timed out, call `result <id> --wait` until it stops printing `STILL_RUNNING`. In a sandbox that blocks writes outside the workspace (e.g. Codex `workspace-write`), set `AGY_COMPANION_STATE_DIR` to a writable path.

## Environment variables

| Variable | Purpose |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `AGY_COMPANION_STATE_DIR` | Override the job/config state directory |
| `AGY_WRITE_MODE` | agy mode for `--write` runs: `default` (default), `auto`, `accept-edits` |
| `AGY_FOREGROUND_WAIT_SECS` | How long foreground commands wait before handing back the job ID (default 540) |
| `AGY_MAX_RUN_SECS` | Hard ceiling on one agy run before it is killed (default 7200) |
| `XDG_STATE_HOME` | Base for the default state directory |

## Development

```bash
npm test         # node:test suite against a fake agy binary
npm run pack     # build the release tarball
claude plugin validate .
```

## License

Apache-2.0. Derived in part from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see [NOTICE](NOTICE). Not affiliated with Google or OpenAI.
