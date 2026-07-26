# Contributing to Loom

Thanks for improving Loom. Keep changes focused, preserve the local-first
model, and add a regression test whenever behavior changes.

## Prerequisites

- Node.js 22.5 or newer
- npm
- Git

Optional integrations require their own CLI and authentication. Do not rely on
those tools for ordinary unit tests; use a fake process or local test server
instead.

## Build and test

From a clean checkout:

```bash
npm ci
npm run build
npm run typecheck
npm test
```

Useful development commands:

```bash
npm run dev -- status
npm test -- test/codex.test.ts
npm run test:watch
```

`npm run verify:adapters` drives installed, authenticated agent CLIs against
real tasks. It may spend provider credits, so run it manually after changing a
real adapter rather than treating it as a normal test-suite step.

Before opening a pull request, run the most focused test first, then
`npm run typecheck`, the relevant broader suite, and `git diff --check`.
Update user-facing documentation when the command, API, or adapter contract
changes.

## Authoring an adapter

Read [`docs/adapters.md`](docs/adapters.md) and
[`src/adapters/README.md`](src/adapters/README.md) before starting. The first
decision is whether the integration is an adapter or a bridge:

| Use an adapter when… | Use a bridge when… |
| --- | --- |
| Loom can start, prompt, stream, interrupt, and account for the agent. | The target is GUI-only or otherwise read-mostly. |
| It may safely hold the baton and edit the working tree. | It must never hold the baton. |
| It implements `send`, `interrupt`, `diff`, and `busy`. | It implements only the common lifecycle and event surface. |

### Implementation checklist

1. Extend `AdapterBase` in `src/adapters/` for a full-duplex agent, or
   `BridgeBase` in `src/adapters/bridges/` for a read-mostly integration.
2. Implement `available`, `start`, and `stop`. Adapters also implement
   `send` and `interrupt`; the base class supplies `busy`, event subscriptions,
   namespaced memory persistence, and a default Git diff.
3. In `send`, reject concurrent turns, set `_busy` before work starts, and
   clear it in `finally`. Forward `SendInput.briefing` through the strongest
   context or system-prompt channel the provider offers.
4. Translate provider activity into factual events: `message`, `tool_call`,
   `file_edit`, `needs_input`, `status`, and `error` as applicable. Emit one
   `run_complete` only for a completed, non-interrupted turn.
5. Make `interrupt` safe when idle. An interrupted turn emits an interruption
   status and does not emit `run_complete`.
6. Register the kind once in `src/adapters/index.ts` and pass any provider
   settings from `AgentConfig.options` into the constructor.
7. Persist resumable provider session identifiers in project state, not global
   process memory. Keep shared-memory writes under `.loom/memory/<agent-id>.md`
   and never overwrite user-authored instruction files.

The public SDK is available to external adapter authors:

```ts
import { AdapterBase, registerAgentKind, type SendInput } from "@loompad/cli/sdk";
```

Register an internal adapter with the same factory shape:

```ts
registerAgentKind("my-agent", (config, projectDir) =>
  new MyAgentAdapter(config.id, "my-agent", projectDir, config.options),
);
```

Declare each configured instance in `.loom/config.json`:

```json
{
  "id": "my-agent",
  "kind": "my-agent",
  "role": "executor",
  "options": {}
}
```

### Testing adapters

Add an adapter-specific test file under `test/`. Use a fake CLI or local server
to record arguments and emit captured provider events. Cover at least:

- availability and startup behavior
- a successful streamed turn and `run_complete`
- busy-turn rejection and safe interruption
- session resume or persistence, if the provider supports it
- provider-specific arguments, context/briefing injection, and error handling

Use the existing `test/codex.test.ts`, `test/claude-code.test.ts`, and
`test/grok.test.ts` suites as patterns. Do not require a contributor's account,
network access, or paid tokens to run unit tests.
