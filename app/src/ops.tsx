import { useEffect, useRef, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, getProjects, type Creds, type Project } from "./api";
import { Panel, SectionLabel, TAP } from "./components";
import { T } from "./theme";
import { opsActionText, opsBytes, policyInput, projectOpsPath, staleReapPath, type MachineOps, type ProjectOps } from "./ops-model";

export function Operations(props: { creds: Creds }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [id, setId] = useState("");
  const [machine, setMachine] = useState<MachineOps | null>(null);
  const [machineError, setMachineError] = useState("");
  const [project, setProject] = useState<ProjectOps | null>(null);
  const [every, setEvery] = useState("1d"), [keep, setKeep] = useState("7");
  const [days, setDays] = useState("7"), [runs, setRuns] = useState("10000");
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const machineGeneration = useRef(0);

  async function loadMachine() {
    const gen = ++machineGeneration.current;
    try {
      const m = await api<MachineOps>(props.creds, "/api/ops");
      if (machineGeneration.current !== gen) return;
      setMachine(m); setMachineError("");
      setEvery(m.backup?.every ?? "1d"); setKeep(String(m.backup?.keep ?? 7));
    } catch (err) { if (machineGeneration.current === gen) setMachineError((err as Error).message); }
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setMachine(null); setMachineError("");
    void loadMachine();
    void getProjects(props.creds).then(r => { if (active) { setProjects(r.projects); setId(r.projects[0]?.id ?? ""); } }).catch(err => { if (active) setResult(err.message); });
    return () => { active = false; generation.current++; machineGeneration.current++; };
  }, [open, props.creds]);
  useEffect(() => {
    const gen = ++generation.current;
    setProject(null); setPreview(null); setResult("");
    if (!id || !open) return;
    void api<ProjectOps>(props.creds, projectOpsPath(id)).then(p => {
      if (generation.current !== gen) return;
      setProject(p); setDays(String(p.policy.days)); setRuns(String(p.policy.keep));
    }).catch(err => { if (generation.current === gen) setResult(err.message); });
    return () => { generation.current++; };
  }, [id, open, props.creds]);

  async function act(path: string, method: string, body?: unknown, done?: (r: Record<string, unknown>) => void) {
    if (busy) return;
    setBusy(true);
    const gen = generation.current;
    try {
      const r = await api<Record<string, unknown>>(props.creds, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (gen !== generation.current) return;
      setResult(opsActionText(r)); done?.(r);
    } catch (err) { if (gen === generation.current) setResult((err as Error).message); }
    finally { setBusy(false); }
  }
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled} onPress={onPress} style={{ minHeight: TAP, justifyContent: "center", opacity: busy || disabled ? 0.4 : 1 }}><Text style={{ color: T.accent, fontSize: 14 }}>{label}</Text></TouchableOpacity>;
  const field = (label: string, value: string, set: (s: string) => void) => <View style={{ gap: 5 }}><Text style={{ color: T.dim }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={set} editable={!busy} autoCapitalize="none" style={{ color: T.text, borderColor: T.line2, borderWidth: 1, borderRadius: 6, padding: 10, minHeight: TAP }} /></View>;
  const prune = (dryRun: boolean) => {
    try {
      const policy = policyInput(days, runs);
      void act(projectOpsPath(id, "worktrees/prune"), "POST", { dryRun, policy }, r => setPreview(dryRun && (r.candidates as string[])?.length ? JSON.stringify(policy) : null));
    } catch (err) { setResult((err as Error).message); }
  };
  return <View style={{ gap: 6 }}><SectionLabel text="Operations" /><Panel>
    {button(open ? "Close operations" : "Open operations", () => setOpen(!open))}
    {open && <View style={{ gap: 12 }}>
      {!!machineError && <Text style={{ color: T.dim }}>{machineError}</Text>}
      {machine && <>
        <SectionLabel text="Scheduled backups" />
        <Text style={{ color: T.dim }}>Runs on your computer while Loom is running. Missed backups run once on restart.</Text>
        {field("Backup interval (1m, 1h, 1d)", every, setEvery)}{field("Backups to keep", keep, setKeep)}
        {button("Save backup schedule", () => { void act("/api/ops/backups", "PUT", { every, keep: Number(keep) }, () => { void loadMachine(); }); })}
        {button("Disable backup schedule", () => { void act("/api/ops/backups", "DELETE", undefined, () => { void loadMachine(); }); })}
        <Text style={{ color: T.dim }}>{machine.backup ? `Next: ${new Date(machine.backup.nextAt).toLocaleString()}${machine.backup.lastAt ? ` · Last success: ${new Date(machine.backup.lastAt).toLocaleString()}` : ""}${machine.backup.error ? ` · Failed: ${machine.backup.error}` : ""}` : "No backup schedule"}</Text>
        <SectionLabel text="Logs and metrics" />
        <Text style={{ color: T.dim }}>Log {opsBytes(machine.log.bytes)} · cap {opsBytes(machine.log.cap)} · previous {opsBytes(machine.log.rotatedBytes)}. Rotation checks every second. Prometheus /metrics requires the admin bearer token.</Text>
        <SectionLabel text="Redacted crash reports" />
        {!machine.crashes.length && <Text style={{ color: T.dim }}>No crash reports</Text>}
        {machine.crashes.map(file => <View key={file}>{button(file, () => { void act(`/api/ops/crashes/${encodeURIComponent(file)}`, "GET"); })}</View>)}
      </>}
      <SectionLabel text="Project" />
      {projects.map(p => <View key={p.id}>{button(`${p.id === id ? "✓ " : ""}${p.name}`, () => setId(p.id))}</View>)}
      {!projects.length && <Text style={{ color: T.dim }}>Add a project to inspect disk usage and sessions.</Text>}
      {project && <>
        <SectionLabel text="Project metrics" />
        <Text style={{ color: T.text }}>Turns {project.metrics.turns} · Cost ${project.metrics.costUsd.toFixed(4)} · Errors {project.metrics.errors} · Queue {project.metrics.queueDepth}</Text>
        <SectionLabel text="Disk usage" />
        <Text style={{ color: T.text }}>Worktrees {opsBytes(project.disk.worktrees)} · Logs {opsBytes(project.disk.logs)} · Attachments {opsBytes(project.disk.attachments)} · Total {opsBytes(project.disk.total)}</Text>
        {!!project.disk.skipped.length && <Text style={{ color: T.warn }}>Unreadable: {project.disk.skipped.join(", ")}</Text>}
        {button("Apply safe doctor fixes", () => { void act(projectOpsPath(id, "doctor/fix"), "POST", {}); })}
        <SectionLabel text="Worktree retention" />
        <Text style={{ color: T.dim }}>Finished Orchestra runs exceeding either limit are pruned automatically. Dirty or locked trees stay; branches stay.</Text>
        {field("Worktree age in days", days, s => { setDays(s); setPreview(null); })}{field("Worktree runs to keep", runs, s => { setRuns(s); setPreview(null); })}
        {button("Save worktree policy", () => { try { void act(projectOpsPath(id, "worktrees/policy"), "PUT", policyInput(days, runs)); } catch (err) { setResult((err as Error).message); } })}
        {button("Dry run", () => prune(true))}{button("Prune now", () => prune(false), preview === null)}
        <SectionLabel text="Stale agent sessions" />
        <Text style={{ color: T.dim }}>Busy for at least 10 minutes. Reap interrupts the session and starts it fresh.</Text>
        {!project.stale.length && <Text style={{ color: T.dim }}>No stale sessions</Text>}
        {project.stale.map(s => <View key={s.agentId}>{button(`Reap ${s.agentId} · ${Math.round(s.busyMs / 60000)}m`, () => { void act(staleReapPath(id, s.agentId), "POST", {}, () => setProject({ ...project, stale: project.stale.filter(x => x.agentId !== s.agentId) })); })}</View>)}
        {button("Refresh report", () => { void act(projectOpsPath(id), "GET", undefined, r => setProject(r as unknown as ProjectOps)); })}
      </>}
      {!!result && <Text accessibilityLiveRegion="polite" selectable style={{ color: T.dim, fontFamily: T.mono, fontSize: 12 }}>{result}</Text>}
    </View>}
  </Panel></View>;
}
