# Windows setup and validation

Use native Windows Node.js 22.5 or newer and Git for Windows. WSL is optional.

```powershell
git clone https://github.com/nickthelegend/loom.git
cd loom
npm.cmd ci
npm.cmd link
loom.cmd --version
```

`scripts/install.ps1` performs a managed source installation. `LOOM_SRC`
chooses the checkout folder; `LOOM_REPO` chooses the repository. Use `loom.cmd`
when PowerShell's script policy prevents npm's `loom.ps1` shim from running.

In a project, run `loom.cmd init`, then `loom.cmd up`. Install and sign in to
the agents you want to use. npm-installed agents and native `.exe` agents are
supported; prompts are passed as literal arguments, including quotes,
newlines, spaces and shell characters. Commands you configure for tests and
transcription use `cmd.exe` on Windows, so write them in Windows shell syntax.

For OpenCode's current native Windows release:

```powershell
npm.cmd install -g opencode-ai@1.19.0
opencode.cmd --version
```

Native continuity supports Codex, Claude Code and OpenCode on Windows. Enable
`brain.continuity` for sequential native chats. Loom probes Job Object assignment
on this host before admitting a native turn; a failed probe leaves it unavailable.
The native binding and delta context survive a daemon restart. Parallel Orchestra
and crews use the ordinary project mode, as on macOS.

Loom uses Koffi's packaged native binding; no local C++ toolchain is required on
supported Windows architectures. A Node bootstrap joins a kill-on-close Job Object
before it can launch the harness. Only the daemon retains a job handle. Shutdown
waits for Windows to report zero job members, including detached tool children;
a failed verification retains the continuity writer lease. Daemon crashes close
the handle and terminate contained processes. Shared pre-existing console hosts
are outside the job.

Antigravity's Windows installer and default `%LOCALAPPDATA%\agy\bin` location
follow its [official installation guide](https://www.antigravity.google/docs/cli/install/).

The terminal uses ConPTY when node-pty loads, with a pipe fallback otherwise.
The dependency is pinned to `node-pty` 1.2.0-beta.15, which includes Microsoft's
[fix for simultaneous Windows terminal exits](https://github.com/microsoft/node-pty/pull/922).
The stable 1.1.0 release still contains that native race. Terminal shutdown waits
for shell exit, and late callbacks from an old shell cannot close its replacement.
Both paths are exercised in CI. The pipe terminal preserves its shell session
when interrupting a foreground process. Windows console hosts are excluded
from ordinary process-tree shutdown.

`loom.cmd runner install` uses your Windows Startup folder. See
[runner setup](teams.md#6-runners-phase-5) for its lifecycle and removal command.

## Verified workflows

- A live Codex conductor ran parallel workers in separate Git worktrees,
  reviewed and integrated their changes, ran a follow-up verification task,
  and applied the result. All four resulting Node tests passed.
- Scripted crew tests cover planning, claims, review, test, apply, questions,
  stop and restart. They use fake agents so CI never spends agent tokens.
- Real Windows terminal checks cover TTY detection, resize, interrupt and
  scrollback. The UI tests exercise an Orchestra turn finishing before the
  WebSocket subscribes, so the thread recovers its missing history.
- Clean phone dependency installation, type checking and 73 phone tests pass
  on Windows. This does not substitute for running the app on a phone.
- The Electron desktop builds as an unpacked app and an NSIS installer. A
  cold packaged launch starts the daemon and opens the web workspace.
- CI runs the full backend and DOM suites on Windows and Ubuntu, on Node 22
  and 24, with both ConPTY/PTY and pipe terminal modes.

## Support limits

Desktop installers are currently unsigned. Trusted signing and an installed
release-to-release update check are still required for issue #70. Hosted
Supabase authentication and cloud sharing need their own deployment and
acceptance checks; local Windows tests do not establish that those hosted
features work.
