/**
 * The Loom TUI — the default face of `loom`. A tabbed, full-screen workspace
 * over every agent in the project:
 *
 *   Thread — the conversation, streamed; tab shifts the active agent, the
 *            handoff happens when you send.
 *   Board  — agents, your cards, issues and PRs, in four columns.
 *   Brain  — the memory the project has learned, grouped by kind.
 *   Diff   — the working tree: changed files and a colourised patch.
 *
 * shift+tab cycles the views; ctrl+p is the command palette; /route runs a
 * pipeline across agents; /pair drops a QR to pair your phone — all without
 * leaving the screen.
 */

import { useApp, useInput, useStdout, render, Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import pc from "picocolors";
import qrcode from "qrcode-terminal";
import type { ProjectStatus } from "../types.js";
import type { BoardData } from "../daemon/board.js";
import type { Memory } from "../core/brain.js";
import { readProjectConfig } from "../core/registry.js";
import { DaemonClient, DaemonError, ensureDaemon } from "../daemon/client.js";
import { resolveCurrentProject, NoProjectError, currentProjectDir } from "./common.js";
import {
  HELP_LINES,
  SPINNER_FRAMES,
  cycleAgent,
  cycleView,
  filterPalette,
  formatBoard,
  formatBrain,
  formatDiff,
  logoLines,
  paletteItems,
  parseSlash,
  renderInput,
  renderTabs,
  switchableAgents,
  VIEWS,
  type PaletteItem,
  type ViewName,
} from "./tui-model.js";
import { formatAgentRow, formatEvent } from "./ui.js";

const PLACEHOLDER = 'Ask anything… "/route ship: add dark mode"';

interface TreeShape {
  git: boolean;
  branch?: string;
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

interface AppProps {
  client: DaemonClient;
  initial: ProjectStatus;
}

function App({ client, initial }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Terminal size, kept live so the viewport tracks a resize.
  const [dims, setDims] = useState({ cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  const { cols, rows } = dims;

  const [view, setView] = useState<ViewName>("thread");
  const [thread, setThread] = useState<string[]>(() => [...logoLines(cols), ""]);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [brain, setBrain] = useState<{ memories: Memory[]; stats: { total: number; byKind: Record<string, number> } } | null>(null);
  const [diff, setDiff] = useState<TreeShape | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);

  const [project, setProject] = useState(initial);
  const [selected, setSelected] = useState<string | null>(
    initial.holder ?? switchableAgents(initial.agents)[0]?.id ?? null,
  );
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [palette, setPalette] = useState<{ open: boolean; query: string; index: number }>({
    open: false,
    query: "",
    index: 0,
  });
  const lastId = useRef(0);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const routeNames = useRef<string[]>([]);

  useEffect(() => {
    const dir = currentProjectDir();
    routeNames.current = Object.keys((dir && readProjectConfig(dir)?.routes) || {});
  }, []);

  const push = useCallback((...added: Array<string | null>) => {
    const real = added.filter((l): l is string => l !== null && l !== undefined);
    if (real.length) setThread((prev) => [...prev, ...real]);
  }, []);

  // Recent history, then live events over the websocket.
  useEffect(() => {
    let closed = false;
    void client
      .events(project.id, undefined, 30)
      .then(({ events }) => {
        if (closed) return;
        lastId.current = events[events.length - 1]?.id ?? 0;
        push(...events.map(formatEvent));
      })
      .catch(() => {});
    const unsubscribe = client.subscribe((pid, e) => {
      if (pid !== project.id || e.id <= lastId.current) return;
      lastId.current = e.id;
      push(formatEvent(e));
    }, project.id);
    return () => {
      closed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Light status poll: holder, busy flags, route progress.
  useEffect(() => {
    const timer = setInterval(() => {
      void client
        .project(project.id)
        .then(({ project: fresh }) => setProject(fresh))
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the active view's data (and keep it fresh) — the thread streams itself.
  useEffect(() => {
    if (view === "thread") return;
    let alive = true;
    const load = () => {
      const done = () => alive && setViewErr(null);
      const fail = (e: unknown) => alive && setViewErr(e instanceof Error ? e.message : String(e));
      if (view === "board") client.board(project.id).then((b) => { if (alive) { setBoard(b); done(); } }).catch(fail);
      else if (view === "brain") client.brain(project.id, { limit: 200 }).then((r) => { if (alive) { setBrain(r); done(); } }).catch(fail);
      else client.tree(project.id).then((r) => { if (alive) { setDiff(r.tree); done(); } }).catch(fail);
    };
    load();
    const timer = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [view, project.id, client]);

  // A fresh view starts at its natural edge (thread at the newest, others at the top).
  useEffect(() => setScroll(0), [view]);

  const busyAgent = project.agents.find((a) => a.busy);

  // Spinner while anyone is working.
  useEffect(() => {
    if (!busyAgent) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, [Boolean(busyAgent)]);

  // Smoke hook: render one real frame, then leave (used by CI/smoke tests).
  useEffect(() => {
    if (!process.env.LOOM_TUI_SMOKE) return;
    const timer = setTimeout(() => exit(), 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCommand = useCallback(
    async (text: string) => {
      const slash = parseSlash(text);
      if (!slash) return;
      const { cmd, args, rest } = slash;
      // Local view jumps never touch the daemon.
      if ((VIEWS as string[]).includes(cmd)) {
        setView(cmd as ViewName);
        return;
      }
      // Everything else produces thread output or a thread effect — show it.
      setView("thread");
      try {
        switch (cmd) {
          case "help":
            push("", ...HELP_LINES, "");
            break;
          case "agents": {
            const { project: fresh } = await client.project(project.id);
            push("", ...fresh.agents.map(formatAgentRow), "");
            break;
          }
          case "handoff": {
            if (!args[0]) return setNotice("usage: /handoff <agent>");
            await client.handoff(project.id, args[0]);
            setSelected(args[0]);
            break;
          }
          case "route": {
            if (args.length < 2) return setNotice("usage: /route <name|a,b,c> <task>");
            const [spec, ...taskWords] = args;
            await client.startRoute(project.id, taskWords.join(" "), spec!);
            break;
          }
          case "routes": {
            const dir = currentProjectDir();
            const routes = (dir && readProjectConfig(dir)?.routes) || {};
            const entries = Object.entries(routes);
            push(
              "",
              ...(entries.length
                ? entries.map(
                    ([name, steps]) =>
                      `  ${pc.cyan(pc.bold(name))}  ${steps
                        .map((s) => (typeof s === "string" ? s : s.step))
                        .join(" → ")}`,
                  )
                : [pc.dim("  no named routes — add them under \"routes\" in .loom/config.json")]),
              "",
            );
            break;
          }
          case "abort":
            await client.abortRoute(project.id);
            break;
          case "decision": {
            if (!rest) return setNotice("usage: /decision <text>");
            await client.decision(project.id, rest);
            setNotice("pinned to shared memory");
            break;
          }
          case "interrupt": {
            const { interrupted } = await client.interrupt(project.id);
            setNotice(interrupted ? `interrupted ${interrupted}` : "nothing running");
            break;
          }
          case "pair": {
            const { token, url } = await client.newPairingToken();
            const link = `${url}/app#pair=${token}`;
            qrcode.generate(link, { small: true }, (qr) => {
              const warn = /127\.0\.0\.1|localhost/.test(url)
                ? [pc.yellow("  ⚠ daemon is on localhost — phones can't reach this QR. Run: loom up --restart --tailnet")]
                : [];
              push("", ...qr.split("\n"), pc.bold(`  ${link}`), pc.dim("  scan with your phone camera · single use · 10 min"), ...warn, "");
            });
            break;
          }
          case "quit":
          case "exit":
            exit();
            break;
          default:
            setNotice(`unknown command /${cmd} — try /help`);
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [client, project.id, push, exit],
  );

  const onSubmit = useCallback(async () => {
    const text = value.trim();
    setValue("");
    setCursor(0);
    setNotice(null);
    if (!text) return;
    history.current.push(text);
    histIdx.current = history.current.length;
    if (text.startsWith("/")) return runCommand(text);
    setView("thread"); // a reply is coming — watch it land
    try {
      if (selected && selected !== project.holder) {
        push(pc.dim(`  ⟶ shifting baton to ${selected}`));
        await client.handoff(project.id, selected);
      }
      await client.send(project.id, text, selected ?? undefined);
    } catch (err) {
      if (err instanceof DaemonError && err.status === 409) {
        setNotice(String(err.body?.message ?? err.message));
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
  }, [value, selected, project.holder, project.id, client, push, runCommand]);

  const runPaletteItem = useCallback(
    (item: PaletteItem | undefined) => {
      setPalette({ open: false, query: "", index: 0 });
      if (!item) return;
      const action = item.action;
      if (action.type === "shift") {
        setSelected(action.agentId);
      } else if (action.type === "insert") {
        setValue(action.text);
        setCursor(action.text.length);
      } else if (action.type === "view") {
        setView(action.view);
      } else {
        void runCommand(`/${action.cmd}`);
      }
    },
    [runCommand],
  );

  // Viewport geometry: chrome is the tab bar + input box + hints + status.
  const CHROME = 9;
  const vh = Math.max(6, rows - CHROME);

  const viewLines: string[] = useMemo(() => {
    if (view === "thread") return thread;
    if (viewErr) return ["", pc.red(`  ${viewErr}`)];
    if (view === "board") return board ? formatBoard(board, cols) : [pc.dim("  loading board…")];
    if (view === "brain") return brain ? formatBrain(brain.memories, brain.stats, cols) : [pc.dim("  loading brain…")];
    return diff ? formatDiff(diff, cols) : [pc.dim("  loading diff…")];
  }, [view, thread, board, brain, diff, viewErr, cols]);

  const total = viewLines.length;
  const maxScroll = Math.max(0, total - vh);
  const clamped = Math.min(Math.max(0, scroll), maxScroll);
  // Thread hangs off the bottom (newest visible); the others read from the top.
  const visible =
    view === "thread"
      ? viewLines.slice(Math.max(0, total - vh - clamped), total - clamped)
      : viewLines.slice(clamped, clamped + vh);
  const hiddenAbove = view === "thread" ? Math.max(0, total - vh - clamped) : clamped;
  const hiddenBelow = view === "thread" ? clamped : Math.max(0, total - vh - clamped);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();

    // ctrl+p — command palette
    if (key.ctrl && input === "p") {
      setPalette((p) => ({ open: !p.open, query: "", index: 0 }));
      return;
    }
    if (palette.open) {
      const matches = filterPalette(
        paletteItems(project.agents, routeNames.current, selected),
        palette.query,
      );
      if (key.escape) return setPalette({ open: false, query: "", index: 0 });
      if (key.return) return runPaletteItem(matches[Math.min(palette.index, matches.length - 1)]);
      if (key.upArrow) return setPalette((p) => ({ ...p, index: Math.max(0, p.index - 1) }));
      if (key.downArrow)
        return setPalette((p) => ({ ...p, index: Math.min(Math.max(matches.length - 1, 0), p.index + 1) }));
      if (key.tab) return;
      if (key.backspace || key.delete) {
        setPalette((p) => ({ ...p, query: p.query.slice(0, -1), index: 0 }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPalette((p) => ({ ...p, query: p.query + input, index: 0 }));
      }
      return;
    }

    // shift+tab cycles views; tab cycles the active agent.
    if (key.tab && key.shift) return setView((v) => cycleView(v, 1));
    if (key.tab) {
      setSelected((s) => cycleAgent(project.agents, s, 1) ?? s);
      return;
    }

    // Scroll the viewport.
    if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + Math.max(1, vh - 2)));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - Math.max(1, vh - 2)));

    // esc — leave a side view first, otherwise interrupt the running turn.
    if (key.escape) {
      if (view !== "thread") return setView("thread");
      void client
        .interrupt(project.id)
        .then(({ interrupted }) => setNotice(interrupted ? `interrupted ${interrupted}` : "nothing running"))
        .catch(() => {});
      return;
    }

    if (key.return) return void onSubmit();
    if (key.upArrow) {
      if (!history.current.length) return;
      histIdx.current = Math.max(0, histIdx.current - 1);
      const recalled = history.current[histIdx.current] ?? "";
      setValue(recalled);
      setCursor(recalled.length);
      return;
    }
    if (key.downArrow) {
      histIdx.current = Math.min(history.current.length, histIdx.current + 1);
      const recalled = history.current[histIdx.current] ?? "";
      setValue(recalled);
      setCursor(recalled.length);
      return;
    }
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
    if (key.ctrl && input === "a") return setCursor(0);
    if (key.ctrl && input === "e") return setCursor(value.length);
    if (key.ctrl && input === "u") {
      setValue("");
      setCursor(0);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  const selectedStatus = project.agents.find((a) => a.id === selected);
  const holdsBaton = selected !== null && project.holder === selected;
  const route = project.route;
  const routeActive = route && (route.status === "running" || route.status === "waiting_human");
  const routeBadge = routeActive
    ? `  ${pc.cyan(`➤ ${route.name ?? "route"} ${route.current + 1}/${route.steps.length}${route.status === "waiting_human" ? " ⏸" : ""}`)}`
    : "";
  const spinner = busyAgent
    ? `${pc.yellow(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} ${pc.dim(`${busyAgent.id} working…`)}`
    : "";

  const paletteMatches = palette.open
    ? filterPalette(paletteItems(project.agents, routeNames.current, selected), palette.query)
    : [];

  const scrollHint =
    hiddenAbove > 0 || hiddenBelow > 0
      ? pc.dim(`${hiddenAbove > 0 ? `↑${hiddenAbove}` : "  "} ${hiddenBelow > 0 ? `↓${hiddenBelow}` : ""}  pgup/pgdn`)
      : "";

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>{renderTabs(view)}</Text>
        <Text>{scrollHint || pc.dim("loom 0.1.0 ")}</Text>
      </Box>
      <Box height={vh} flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
      {notice ? <Text color="yellow">{`  ${notice}`}</Text> : null}
      {palette.open ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text>
            {pc.cyan("⌘ ")}
            {renderInput(palette.query, palette.query.length, "type to filter commands…")}
          </Text>
          {paletteMatches.slice(0, 8).map((item, i) => {
            const active = i === Math.min(palette.index, paletteMatches.length - 1);
            const label = `${item.label}${item.hint ? pc.dim(`  ${item.hint}`) : ""}`;
            return <Text key={item.id}>{active ? pc.cyan(`› ${label}`) : `  ${label}`}</Text>;
          })}
          {!paletteMatches.length ? <Text dimColor>{"  no matches"}</Text> : null}
        </Box>
      ) : null}
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        <Text>
          {pc.cyan("› ")}
          {renderInput(value, cursor, PLACEHOLDER)}
        </Text>
        <Text dimColor>
          {selected ?? "no agent"}
          {selectedStatus ? ` · ${selectedStatus.role}` : ""}
          {holdsBaton ? pc.magenta(" ⟵ baton") : pc.dim("  (send = shift baton)")}
          {spinner ? `   ${spinner}` : ""}
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{"  shift+tab view · tab agent · ctrl+p palette · esc back/interrupt · ctrl+c quit"}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text>
          <Text dimColor>
            {`  ~ ${project.name} · baton ${project.holder ?? "—"}` +
              (project.costUsd && project.costUsd > 0
                ? ` · ${project.costUsd >= 0.01 ? `$${project.costUsd.toFixed(2)}` : `$${project.costUsd.toFixed(4)}`}`
                : "")}
          </Text>
          <Text>{routeBadge}</Text>
        </Text>
        <Text dimColor>{project.needsInput ? pc.yellow("● needs input ") : ""}</Text>
      </Box>
    </Box>
  );
}

export async function runTui(): Promise<void> {
  const client = await ensureDaemon();
  let project: ProjectStatus;
  try {
    project = await resolveCurrentProject(client);
  } catch (err) {
    if (err instanceof NoProjectError) {
      for (const line of logoLines(process.stdout.columns ?? 80)) console.log(line);
      console.log();
      console.log(pc.dim("  no Loom project here — run ") + pc.bold("loom init") + pc.dim(" first"));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const { waitUntilExit } = render(<App client={client} initial={project} />, {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
  process.exit(0);
}
