# Adapter contract

This directory contains Loom's integrations with coding agents. An integration
is either an **adapter**, which Loom can drive and give the baton to, or a
**bridge**, which Loom can observe but never lets edit under the baton.

| Capability | Adapter | Bridge |
| --- | --- | --- |
| May hold the baton | Yes | No |
| Receives prompts | Yes (`send`) | No |
| Can be interrupted | Yes | No |
| Reports working-tree changes | Yes (`diff`) | No |
| Streams events | Yes | Yes, when available |
| Receives shared memory | Yes | Yes |

Choose a bridge when the target is a GUI-only or otherwise read-mostly
surface. Do not expose `send` on a bridge to work around the distinction: the
baton is Loom's guarantee that only a controllable agent is authorized to edit
the working tree.

## Public interface

The source of truth is `src/types.ts`. `AdapterBase` and `BridgeBase` in
`base.ts` implement the shared parts of the contract, including event
subscription and the default memory-file persistence.

```ts
interface SendInput {
  text: string;
  briefing?: string;
}

interface AdapterEvent {
  kind: EventKind;
  payload: Record<string, unknown>;
}

interface BaseAgent {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: AgentCapabilities;
  available(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  injectMemory(projection: string): Promise<void>;
  onEvent(callback: (event: AdapterEvent) => void): () => void;
}

interface Adapter extends BaseAgent {
  send(input: SendInput): Promise<void>;
  interrupt(): Promise<void>;
  diff(): Promise<string>;
  busy(): boolean;
}
```

`id` identifies a configured agent instance and must remain stable within a
project. `kind` identifies its registered implementation. `capabilities` must
truthfully describe the implementation; the base classes set the appropriate
values for their tier.

## Lifecycle and turns

1. `available()` checks whether the underlying CLI, service, or GUI endpoint
   is usable. Return `false` for an unavailable dependency rather than claiming
   it is ready.
2. `start()` initializes any long-lived connection or session and may emit a
   `status` event such as `{ state: "ready" }`.
3. `send()` runs one complete adapter turn. Reject concurrent calls while
   `busy()` is true, set `_busy` before starting work, and reset it in a
   `finally` block.
4. During the turn, emit events as they are observed. `send()` resolves only
   after the underlying turn has completed or been interrupted.
5. `stop()` releases resources. It should safely stop an active turn, usually
   by delegating to `interrupt()`.

On a normally completed turn, emit exactly one `run_complete` event, normally
with `durationMs` and any provider-reported `costUsd`. A provider-reported
failure can still be a completed turn: emit `error`, then `run_complete` when
the provider has finished its response. If the process or transport fails
before a completed turn, emit useful `error` context and reject `send()`.

`interrupt()` must be safe when no turn is active. For an interrupted turn,
stop the underlying work, emit `status` with an `interrupted` state, clear the
busy flag, and **do not** emit `run_complete`. Loom must not record an aborted
turn as completed.

## Events

Events are the adapter's observable transcript. Keep them factual and emit
them promptly; Loom records them and uses them for the board, notifications,
handoffs, memory projections, and turn accounting.

| Event | Conventional payload | Meaning |
| --- | --- | --- |
| `message` | `{ text, reasoning? }` | Agent-visible prose or reasoning. |
| `tool_call` | `{ tool, summary, ... }` | A tool invocation or completed tool operation. |
| `tool_result` | Provider-specific details | A useful tool result, when available. |
| `file_edit` | `{ path, ... }` | A file the agent changed. |
| `needs_input` | `{ question }` | The agent is blocked on a human response. |
| `run_complete` | `{ durationMs?, costUsd? }` | One finished, non-interrupted turn. |
| `status` | `{ state, ... }` | Lifecycle, session, token, or interruption state. |
| `error` | `{ message, ... }` | A provider or adapter failure. |

`AdapterEvent.payload` is intentionally extensible. Preserve provider-specific
metadata when it is useful, but supply the conventional fields above so Loom's
generic UI and projections can interpret the event. Do not invent cost data:
omit `costUsd` when the provider does not report it.

The complete `EventKind` union also includes project-level events such as
`handoff`, `decision`, routes, memory updates, and `turn_diff`. Adapters
normally emit only events that they directly observe; Loom owns the
project-level events and computes `turn_diff` after a completed adapter turn.

## Memory and diffs

`injectMemory(projection)` persists the shared-memory projection for this
agent. The `AgentBase` implementation writes it to:

```
.loom/memory/<agent-id>.md
```

Use the default unless the target offers a richer, additive memory surface.
Never overwrite user-authored instructions or configuration files. `briefing`
is separate: it is one-shot handoff context for the next `send()` and should
be passed through the strongest context or system-prompt mechanism offered by
the target.

`AdapterBase.diff()` defaults to `git status --porcelain` in the project root.
Override it only when the provider can supply a more accurate, compatible
working-tree summary. A bridge has no diff capability because it never holds
the baton.

## Implementation template

```ts
import { AdapterBase, registerAgentKind, type SendInput } from "@loompad/cli/sdk";

export class MyAgentAdapter extends AdapterBase {
  async available(): Promise<boolean> {
    return true; // Check the target CLI or service here.
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "ready" } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`${this.id} is busy`);
    this._busy = true;
    const startedAt = Date.now();

    try {
      const reply = await callProvider(input.text, input.briefing);
      this.emit({ kind: "message", payload: { text: reply } });
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - startedAt } });
    } finally {
      this._busy = false;
    }
  }

  async interrupt(): Promise<void> {
  }
}

registerAgentKind("my-agent", (config, projectDir) =>
  new MyAgentAdapter(config.id, "my-agent", projectDir),
);
```

Register each kind once in `index.ts` (or in the startup module that loads a
community integration). The factory receives the full `AgentConfig`, so pass
`config.options` to an adapter constructor when it supports provider-specific
settings. Persist resumable provider session IDs with the project-state helpers
in `src/core/registry.ts`, not in global process state.

See the existing adapters for provider-specific process handling and event
translation: `claude-code.ts`, `codex.ts`, `opencode.ts`, and `grok.ts`.
