---
name: loom-agents
description: Add Loom agent sessions, select models/providers, and configure access, defaults, and chat instructions. Use for "add another Codex", "connect an ACP agent", "use a model endpoint", or "change this agent's permissions".
---

# Configure agents

Run project commands inside the target Loom project. Inspect before changing:

```sh
loom agents --json
loom agents:available --json
loom providers
loom models
loom defaults --json
loom limits --json
```

Use the roster's IDs to address sessions; a kind identifies the implementation.
Agent availability outside a project describes the machine, not a project roster.
Installed does not mean signed in; `loom doctor` diagnoses authentication and PATH.

## Add sessions

```sh
loom agents:add codex --as builder --role executor
loom agents:add codex --as reviewer --role reviewer
loom agents:add grok-code --as planner --role planner
```

Repeated adds without `--as` allocate kind, kind-2, kind-3, and so on.
Adding is not idempotent: inspect the roster before repeating an uncertain command.
Sessions have separate context windows but share the project brain and write baton.
`--role` is a free-text role; it does not grant read-only access or change permissions.
Use `loom models builder` to discover models the agent actually reports.
`--model` on agents:add selects a model where the adapter supports it; use a returned
model ID, not a guessed model name. The kind is positional, not a `--kind` option.

## Connect ACP

```sh
loom agents:add acp --preset gemini --as gemini
loom agents:add acp --preset claude --as claude-acp
loom agents:add acp --cmd "my-agent --acp" --as custom-acp
```

Presets are claude, codex, gemini, opencode, and grok. Use either a known preset
or the actual installed agent's stdio ACP command. `my-agent` is a placeholder.
`--cmd` is whitespace-split, not a shell expression; do not put pipelines,
shell substitutions, or arguments requiring nested quoting in it.
ACP sessions resume per chat when supported. Permission requests follow Loom's
access mode and fail closed when cancelled or interrupted.

## Connect a model endpoint

```sh
loom providers
loom models --provider openrouter --free --refresh
loom agents:add model --as helper --provider openrouter --model MODEL_ID --tools
loom agents:add model --as editor --provider openrouter --model MODEL_ID --tools --write --run "npm test,npm run lint"
```

Replace `MODEL_ID` with an available model from that provider's listing.
Without `--tools`, a model agent has no project tools. With it, reads are confined
to the project. Both `--write` and `--run` require `--tools`.
The run list allows command prefixes; it is not unrestricted shell access.
In auto/ask, writes and commands require approval cards; bypass removes that check.
`loom providers` shows masked configuration as the daemon sees it and calls out
keys visible only in this shell. Models/providers have no `--json` flag here.
Keep keys in the user's provider settings or daemon environment, never in prompts
or project files. Do not print secret files to debug a provider.

## Choose access explicitly

```sh
loom agents:mode builder
loom agents:mode builder auto
loom agents:mode reviewer ask
```

Without a mode, inspect supported modes and their actual meaning for that adapter.
`auto` uses the adapter's sandbox/default policy; it is not the same across agents.
`ask` requests approvals where supported; some adapters map it to planning mode
and others do not support it. Read the profile before relying on it for unattended work.
`bypass` means no sandbox: the agent can run commands, commit, push, and use the
network as the user. Only choose `loom agents:mode builder bypass` when that access
is authorized. Never use it as an automatic fix for denied network or git writes.

## Defaults and instructions

```sh
loom defaults --agents codex,opencode --mode auto --mode-for codex=ask --gitignore on
loom chat:instructions "Preserve the public API; run the affected tests." --chat main
loom chat:instructions --chat main
loom chat:instructions --chat main --clear
```

Defaults live in `~/.loom/defaults.json` and apply on `loom init`.
They add missing installed agents and fill unset modes; they do not remove sessions
or override modes already chosen. Treat changes as preferences across projects.
Chat instructions apply on every turn in that chat regardless of who answers.
Use the chat ID or title; do not put credentials or one-off tasks in standing guidance.

## Diagnose and bound usage

- Unknown ID: read the roster; use the instance ID rather than an assumed kind name.
- No model: select a real ID with models and supply `--model` when adding model kind.
- Signed out or missing CLI: complete that agent's installation/login; rerun doctor.
- Shell-only key: configure the daemon's provider access; avoid a disruptive restart.
- Too many sessions running: inspect `loom limits`; changes such as
  `loom limits --turns 2 --min-free 25` affect every project and take effect without restart.

Never commit `.loom/`. Never forcibly restart while someone's turns run.
