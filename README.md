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
- Node.js 18.18+ and git.

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
tar -xzf agy-plugin-cc-0.1.0.tar.gz -C ~/plugins
# in Claude Code:
/plugin marketplace add ~/plugins/agy-plugin-cc-0.1.0
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

- Writes by default (`agy --mode auto`); `--read-only` uses `agy --mode plan`.
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

When enabled for a repo, each time Claude is about to stop, Antigravity checks that turn's edits and can block the stop with a reason. It adds a minute or more per turn — leave it off unless you want it.

## How it works

Everything goes through `plugins/agy/scripts/agy-companion.mjs`, which calls:

```text
agy --mode plan|auto --dangerously-skip-permissions --output-format json -p "<prompt>"
```

- Read-only runs use `--mode plan`. The companion deliberately does **not** pass `--disable-slash-commands`: in agy 1.4.x that flag makes `--mode plan` a silent no-op, so a "read-only" run could edit files. Instead, a leading `/` in a prompt is neutralised.
- Review output is a JSON contract in the prompt (`schemas/review-output.schema.json`), parsed and rendered as Markdown. `agy --json-schema` isn't used because it rejects schemas when tools are active.
- `AGY_COMPANION_DEPTH` is set on every agy child, so a companion launched from inside Antigravity refuses to recurse.
- Job state lives in `$XDG_STATE_HOME/agy-plugin-cc` (default `~/.local/state/agy-plugin-cc`), one folder per repo. Override with `AGY_COMPANION_STATE_DIR`.

### Using it from Codex or other agents

The companion is a plain Node CLI, so any agent can use it:

```bash
node plugins/agy/scripts/agy-companion.mjs adversarial-review --scope decision "..."
node plugins/agy/scripts/agy-companion.mjs task --read-only --prompt-file brief.md
node plugins/agy/scripts/agy-companion.mjs --help
```

Prompt guidance for delegated tasks is in `plugins/agy/skills/agy-prompting/`.

## Environment variables

| Variable | Purpose |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `AGY_COMPANION_STATE_DIR` | Override the job/config state directory |
| `XDG_STATE_HOME` | Base for the default state directory |

## Development

```bash
npm test         # node:test suite against a fake agy binary
npm run pack     # build the release tarball
claude plugin validate .
```

## License

Apache-2.0. Derived in part from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see [NOTICE](NOTICE). Not affiliated with Google or OpenAI.
