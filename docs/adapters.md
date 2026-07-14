# Writing a Loom adapter or bridge

Loom's integration model has **two tiers**, and picking the right one is the first
decision:

| | Adapter | Bridge |
|---|---|---|
| Can hold the baton (write lock) | ✅ | ❌ never |
| Must implement | `send`, live events, `injectMemory`, `interrupt`, `diff` | events (best-effort), `injectMemory` |
| For | agents with a real API / headless mode | GUI agents without a stable control surface |
| Examples | Claude Code, OpenCode | Antigravity |

This split is deliberate (see [ARCHITECTURE.md](../ARCHITECTURE.md)): the baton
authorizes *edits to the user's working tree*, so it can only be held by an agent Loom
can reliably start, stream, interrupt, and account for. If your target tool only exposes
a debug port and pixels, build a bridge; if it exposes an API, build an adapter. A
bridge can graduate later.

## The contract

Everything lives in `loom-agents/sdk`:

```ts
import {
  AdapterBase,      // extend for adapters
  BridgeBase,       // extend for bridges
  registerAgentKind,
  type SendInput,   // { text, briefing? }
  type AdapterEvent // { kind, payload }
} from "loom-agents/sdk";
```

### Events you can emit

| kind | payload | when |
|---|---|---|
| `message` | `{ text }` | your agent produced prose |
| `tool_call` | `{ tool, summary }` | it used a tool |
| `file_edit` | `{ path }` | it changed a file |
| `needs_input` | `{ question }` | it is blocked on the human → triggers a notification |
| `run_complete` | `{ durationMs?, costUsd? }` | the turn finished → notification |
| `status` | `{ state, … }` | lifecycle (ready / interrupted / …) |
| `error` | `{ message }` | something broke |

Every event you emit is appended to the project's event log — which is exactly what gets
projected into the *next* agent's memory on handoff. Emit honestly and your agent's work
becomes context for everyone else.

### A complete adapter

```ts
import { AdapterBase, registerAgentKind, type SendInput } from "loom-agents/sdk";

export class MyAgentAdapter extends AdapterBase {
  // available(): is the underlying tool installed/reachable?
  async available(): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {
    // boot your server / warm your session; emit a status event
    this.emit({ kind: "status", payload: { state: "ready" } });
  }

  async stop(): Promise<void> {}

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`${this.id} is busy`);
    this._busy = true;
    try {
      // input.briefing is the one-shot handoff context — inject it however
      // your agent accepts system/context input. Claude Code uses
      // --append-system-prompt; OpenCode gets a delimited preamble.
      const reply = await callMyAgent(input.text, input.briefing);
      this.emit({ kind: "message", payload: { text: reply } });
      this.emit({ kind: "run_complete", payload: {} });
    } finally {
      this._busy = false;
    }
  }

  async interrupt(): Promise<void> {
    // stop the in-flight turn (kill the process, call the abort route, …)
  }

  // diff() has a default implementation (git status --porcelain).
  // injectMemory() has a default implementation writing the namespaced
  // .loom/memory/<id>.md file — override only if your agent has a richer
  // native memory surface. NEVER write into user-authored files.
}

registerAgentKind("my-agent", (cfg, dir) => new MyAgentAdapter(cfg.id, "my-agent", dir));
```

Users then declare it in `.loom/config.json`:

```json
{ "id": "my-agent", "kind": "my-agent", "role": "executor", "options": {} }
```

`cfg.options` arrives in your constructor if you define one — see
`src/adapters/claude-code.ts` and `src/adapters/opencode.ts` for real examples,
including session persistence via project state.

### A bridge

```ts
import { BridgeBase, registerAgentKind } from "loom-agents/sdk";

export class MyGuiBridge extends BridgeBase {
  async available() { return true; }
  async start() {
    this.emit({ kind: "status", payload: { state: "observed" } });
  }
  async stop() {}
  // injectMemory() default keeps .loom/memory/<id>.md fresh — the human
  // driving the GUI agent points it at that file.
}

registerAgentKind("my-gui", (cfg, dir) => new MyGuiBridge(cfg.id, "my-gui", dir));
```

## Ground rules

1. **Never block `send()` on user interaction** — emit `needs_input` and finish the turn.
2. **Interrupt must be safe** — a confirmed handoff interrupts you; leave the tree in a
   sane state (that's why baton holders are adapters only).
3. **Emit `run_complete` exactly once per turn** — notifications and suggestions key off it.
4. **Respect namespacing** — your memory surface is `.loom/memory/<your-id>.md` and
   whatever *additive* mechanism your agent offers. User files are off-limits.
5. **Persist session state** via project state (see `readProjectState` /
   `writeProjectState`) so `--resume`-style continuity survives daemon restarts.
