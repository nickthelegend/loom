# Scripts

| Script | What it does |
|---|---|
| `install.sh` | One-line install: clone, build, link `loom` (`curl -fsSL …/scripts/install.sh \| bash`) |
| `stage-daemon.mjs` | Copies the built daemon into `desktop/build/daemon` before packaging the desktop app |
| `gen-brand-icons.mjs` | Regenerates the app and agent brand icons |
| `verify-adapters.mjs` | Drives every installed agent CLI through a real turn |
| `verify-permissions.mjs` | The bypass / auto / always-ask matrix, per CLI |
| `verify-approvals.mjs` | "Always ask" approvals end to end with a real Claude |
| `verify-orchestra.mjs` | A real orchestra run with real agents |
| `verify-team-overlap.mjs` | A real orchestrator answering a teammate overlap hold |

The `verify-*` scripts use real agents and spend real tokens; they're for
checking a machine, not for CI.
