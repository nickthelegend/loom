# Setting up Loom

Read this before installing. Loom drives other people's coding agents, so most
of the setup is really *their* setup — and the parts that bite are the ones
nobody warns you about.

Everything here was hit for real on a machine, not copied from a wiki. Where
something is a guess, it says so.

---

## 1. The one hard requirement: Node ≥ 22.5

```sh
node --version
```

Loom's event log uses `node:sqlite`, which arrived in Node 22.5. On anything
older Loom still runs and **silently falls back to a JSONL store with no
history** — the app looks fine and your past turns aren't there.

> **The installed desktop app has this problem too.** Electron 33 bundles Node
> 20, so `Loom.app` looks for a real `node` on your machine (`$LOOM_NODE`, then
> the usual install paths, then `PATH`). If it can't find one, it runs on
> Electron's Node and degrades exactly as above. There is no warning yet. See
> `desktop/BUILD.md`.

- **macOS**: `brew install node`
- **Windows**: `winget install OpenJS.NodeJS`
- **Linux**: your distro's node, or [nodesource](https://github.com/nodesource/distributions)

---

## 2. Install at least one agent

Loom has nothing to drive on its own. A new project is given whichever of these
it finds — and **an empty roster if it finds none**, which is honest but not
useful.

| Agent | Install | Sign in | Check |
|---|---|---|---|
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | `claude` (once, interactively) | `claude --version` |
| **Codex** | [Codex.app](https://openai.com/codex/), or `npm i -g @openai/codex` | `codex login` | `codex login status` |
| **OpenCode** | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` | `opencode --version` |
| **Grok Code** | [docs.x.ai](https://docs.x.ai) | `grok` (once, interactively) | `grok --version` |

Two things worth knowing:

**Codex's CLI hides inside its app.** On a Mac with Codex.app installed and
nothing on `PATH`, the binary is at
`/Applications/Codex.app/Contents/Resources/codex`. Loom looks there as well as
on `PATH`, so you don't have to do anything — but that's why `which codex`
coming up empty doesn't mean it's missing.

**Being logged in is not optional and not detectable in advance.** Loom probes
whether a CLI *exists*, not whether it's authenticated. An unauthenticated agent
looks installed, takes your turn, and fails. Run each one once by hand first.

Then ask Loom what it can see:

```sh
loom doctor
```

---

## 3. GUI agents: Antigravity IDE and Kiro

These have no API and no headless mode. Loom drives them through the Chrome
DevTools port they open *only if you ask*, so they need a launch flag.

### Which Antigravity?

There are two apps and only one of them is the right one.

| | What it is | Use it? |
|---|---|---|
| **Antigravity.app** | the Manager — a web page behind a Google sign-in | ❌ no chat DOM at all |
| **Antigravity IDE.app** | the VS Code fork with the agent in it | ✅ this one |

Pointing Loom at the Manager finds nothing and reports that Antigravity has no
chat. It's the wrong app, not a broken bridge.

### Why port 9333 and not 9222

Antigravity's own Browser Control (the Chrome button in its toolbar) already
uses **9222**. Ask for it and you get `EADDRINUSE` — and the IDE starts anyway,
just without a debugger, silently. Use **9333**.
(Discovered by the [AntiGravity-AutoAccept](https://github.com/yazanbaker94/AntiGravity-AutoAccept)
project.)

### macOS

```sh
open -a "Antigravity IDE" --args --remote-debugging-port=9333 /path/to/your/repo
```

Make it permanent in `~/.zshrc`:

```sh
alias antigravity='open -a "Antigravity IDE" --args --remote-debugging-port=9333'
```

If `open -a` doesn't pass the flag through on your build, go direct:

```sh
alias antigravity='"/Applications/Antigravity IDE.app/Contents/MacOS/Electron" --remote-debugging-port=9333 & disown'
```

Or make an Automator **Application** with one *Run Shell Script* action
containing the `open -a` line, and launch that instead of the dock icon.

**Only one instance gets the port.** If Antigravity is already running, a second
launch just focuses the first window and your flag is ignored — the port stays
closed and nothing says so. Quit it fully first:

```sh
pkill -f "Antigravity" && sleep 2
```

### Windows

Right-click the Antigravity IDE shortcut → **Properties** → append to *Target*:

```
--remote-debugging-port=9333
```

Launch from that shortcut afterwards, not from search results or a pinned
taskbar entry pointing elsewhere.

### Linux

```sh
# find the launcher
find /usr/share/applications ~/.local/share/applications -name "*ntigravity*"
# then edit its Exec line:
Exec=/path/to/antigravity --remote-debugging-port=9333 %F
```

or an alias in `~/.bashrc`:

```sh
alias antigravity='antigravity --remote-debugging-port=9333'
```

### Kiro

Same idea, **port 9334** so it can't collide with Antigravity:

```sh
open -a "Kiro" --args --remote-debugging-port=9334        # macOS
```

Kiro's chat panel must be **open** — on a fresh window its only editable area is
Monaco, holding your source file, and Loom refuses to type into that on purpose.

### Then check it

```sh
loom doctor
```

Loom distinguishes *reachable* from *driveable*, because a signed-out app
answers the debugger cheerfully and has no usable chat:

- `Antigravity IDE isn't listening — open -a "Antigravity IDE" --args --remote-debugging-port=9333` → the flag didn't take
- `Antigravity IDE is signed out — log in from its window` → the app is up; **log into it**
- `no chat panel — open a chat` → it's up and signed in; open a conversation

---

## 4. Permissions

### macOS

| What | Needed for | How |
|---|---|---|
| **Notifications** | "your agent needs you" while you're elsewhere | First `loom up` asks. Otherwise: System Settings → Notifications → Loom |
| **Open a downloaded app** | Loom.app isn't notarized yet | **Right-click → Open** the first time. Double-clicking gives "cannot be opened" with no way forward |
| **Local Network** | your phone reaching the daemon over LAN | Prompted on first connection. System Settings → Privacy & Security → Local Network |

**Not needed, despite what you might expect:** Accessibility, Screen Recording,
Automation, Full Disk Access. Loom drives GUI agents through their debugging
port, not by pretending to be a mouse, so it never asks the OS for control of
another app. If something tells you to grant Accessibility to Loom, that isn't
Loom.

### Windows

| What | Needed for | How |
|---|---|---|
| **Firewall (private networks)** | your phone reaching the daemon | Windows Defender prompts on first `loom up` — tick **Private networks**. Public: leave off |
| **SmartScreen** | the installer isn't signed yet | **More info → Run anyway** |
| **Notifications** | agent alerts | Settings → System → Notifications → Loom |

---

## 5. Staying open, and staying running

**The daemon already outlives the window.** It's spawned detached — close the
app and your agents keep working; reopen and you're back where you were. That's
the design, not a leak. To stop it for real:

```sh
loom down
```

**Run it at login (optional).** No installer wires this up yet; do it yourself:

- **macOS** — System Settings → General → Login Items → **+** → Loom.app. Or a
  LaunchAgent running `loom up`.
- **Windows** — `Win+R` → `shell:startup` → shortcut to Loom.
- **Linux** — a user systemd unit running `loom up`.

**Always on top** is the window manager's job, not Loom's: right-click the title
bar (Windows), or use a tiling/stage manager (macOS). Loom doesn't ask for it —
a tool that forces itself in front of your editor is a tool you'll uninstall.

---

## 6. Your phone

The phone app talks to the daemon on your own machine. Nothing goes through a
server of ours, because there isn't one.

1. **Install Tailscale** on both, sign into the same tailnet: [tailscale.com/download](https://tailscale.com/download)
2. **Bind Loom to the tailnet** — by default it listens on localhost only and your phone cannot see it:
   ```sh
   loom up --restart --tailnet
   ```
3. **Pair**: `loom pair` prints a QR code. Scan it.

Two things that will confuse you otherwise:

- `loom doctor` saying *"binding localhost only — phones can't reach it"* is the
  whole answer. Re-run with `--tailnet`.
- The pairing token is single-use and the client token it hands back lives on the
  phone. Losing the phone means `loom` → unpair that client, not rotating
  everything.

---

## 7. When it's wrong

```sh
loom doctor          # what Loom can see, and what it can't
tail -f ~/.loom/daemon.log
```

**A change you made isn't showing up.** The daemon is a long-lived process; it
serves the code it started with. `loom up` compares fingerprints and restarts a
stale one automatically, but if you're staring at yesterday's behaviour:

```sh
loom down && loom up
```

**"daemon already running" but it's on the wrong port.** Something else has
7420. `lsof -ti tcp:7420` (macOS/Linux) or `netstat -ano | findstr 7420`
(Windows).

**An agent takes the turn and nothing happens.** It's almost always
authentication. Run that agent by hand in a terminal once — it'll tell you what
Loom can't.
