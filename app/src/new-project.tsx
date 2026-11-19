/**
 * + Project, on the phone (#371): start a project on your computer from a name, or clone one from
 * a URL, and choose who works in it — two Claudes on Opus and a Codex, say. The computer makes the
 * folder under its Loom projects folder, so there is no path to type. When it's ready the project
 * opens. Approach after T3 Code's AddProjectScreen (MIT).
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { cloneProject, createProject, getStarterTemplates, type StarterTemplate, getProjectJob, getSetupAgents, tryDemo, type Creds, type SetupAgent } from "./api";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

type Pick = { on: boolean; model: string; count: number };

export function NewProjectSheet(props: {
  visible: boolean;
  creds: Creds;
  onClose: () => void;
  /** Called with the new project's id once it's registered; the board opens it. */
  onCreated: (projectId: string) => void;
}) {
  const [mode, setMode] = useState<"new" | "clone">("new");
  const [template, setTemplate] = useState("");
  const [templates, setTemplates] = useState<StarterTemplate[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [agents, setAgents] = useState<SetupAgent[] | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const open = useRef(false);

  useEffect(() => {
    open.current = props.visible;
    if (!props.visible) return;
    setName(""); setUrl(""); setErr(null); setBusy(false); setProgress(""); setPicks({});
    setAgents(null); setTemplate("");
    void getStarterTemplates(props.creds).then(r => { if (open.current) setTemplates(r.templates); }).catch(e => { if (open.current) setErr(String(e.message)); });
    void getSetupAgents(props.creds)
      // the demo agent is for `Try a demo project`, not for a real one
      .then((r) => { if (open.current) setAgents(r.agents.filter((a) => a.found && a.kind !== "demo")); })
      .catch(() => { if (open.current) setAgents([]); });
  }, [props.visible]);

  const pick = (kind: string): Pick => picks[kind] ?? { on: false, model: "", count: 1 };
  const setPick = (kind: string, next: Partial<Pick>) => setPicks((m) => ({ ...m, [kind]: { ...pick(kind), ...next } }));

  const fail = (e: unknown) => { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); setProgress(""); };

  const create = async () => {
    setErr(null);
    if (mode === "new") {
      if (!name.trim()) return setErr("Give it a name.");
      const chosen = Object.entries(picks).filter(([, p]) => p.on).map(([kind, p]) => ({
        kind, ...(p.model.trim() ? { model: p.model.trim() } : {}), ...(p.count > 1 ? { count: p.count } : {}),
      }));
      if (picks.model?.on && !picks.model.model.trim()) return setErr("Model (API) needs a model id — it can't answer without one.");
      setBusy(true);
      try {
        const { project } = await createProject(props.creds, name.trim(), chosen, template || undefined);
        props.onCreated(project.id);
      } catch (e) { fail(e); }
      return;
    }
    if (!url.trim()) return setErr("Paste the repository's URL.");
    setBusy(true);
    setProgress("Starting the clone…");
    try {
      const { jobId } = await cloneProject(props.creds, url.trim(), name.trim() || undefined);
      for (;;) {
        if (!open.current) return; // closed: the clone carries on and shows up on the board
        const job = await getProjectJob(props.creds, jobId);
        if (job.status === "done" && job.project) return props.onCreated(job.project.id);
        if (job.status === "failed") return fail(new Error(job.error || "the clone failed"));
        if (job.progress) setProgress(job.progress);
        await new Promise((r) => setTimeout(r, 900));
      }
    } catch (e) { fail(e); }
  };

  const demo = async () => {
    setErr(null); setBusy(true); setProgress("Setting up the demo…");
    try { const { project } = await tryDemo(props.creds); props.onCreated(project.id); }
    catch (e) { fail(e); }
  };

  const seg = (m: "new" | "clone", label: string) => (
    <TouchableOpacity
      key={m}
      onPress={() => { setMode(m); setErr(null); }}
      disabled={busy}
      activeOpacity={0.7}
      accessibilityRole="tab"
      accessibilityState={{ selected: mode === m }}
      style={{ flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.key - 2,
        backgroundColor: mode === m ? T.raised : "transparent" }}
    >
      <Text style={{ color: mode === m ? T.text : T.dim, fontSize: 14, fontWeight: "700" }}>{label}</Text>
    </TouchableOpacity>
  );
  const field = { color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 12, height: 44, fontSize: 15 } as const;
  const label = (text: string) => <Text style={{ color: T.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>{text}</Text>;

  return (
    <Sheet title="New project" visible={props.visible} onClose={props.onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <View style={{ flexDirection: "row", padding: 3, borderRadius: radii.key, borderWidth: 1, borderColor: T.line }}>
          {seg("new", "New")}
          {seg("clone", "Clone")}
        </View>

        {mode === "clone" && (
          <View style={{ gap: 6 }}>
            {label("REPOSITORY URL")}
            <TextInput value={url} onChangeText={setUrl} placeholder="https://github.com/you/repo.git" placeholderTextColor={T.faint}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Repository URL" style={field} editable={!busy} />
            <Text style={{ color: T.faint, fontSize: 12, lineHeight: 17 }}>Cloned on your computer, with its own git sign-in.</Text>
          </View>
        )}

        <View style={{ gap: 6 }}>
          {label(mode === "new" ? "NAME" : "NAME (OPTIONAL)")}
          <TextInput value={name} onChangeText={setName} placeholder={mode === "new" ? "e.g. landing page" : "defaults to the repo name"}
            placeholderTextColor={T.faint} accessibilityLabel="Project name" style={field} editable={!busy} returnKeyType="done" />
          {mode === "new" && <Text style={{ color: T.faint, fontSize: 12, lineHeight: 17 }}>A new folder in Loom Projects on your computer, with git and a first commit.</Text>}
        </View>

        {mode === "new" && (
          <View style={{ gap: 6 }}>
            {label("STARTER TEMPLATE")}
            {[{ name: "", description: "Empty project" }, ...templates].map(t => (
              <TouchableOpacity key={t.name} disabled={busy} onPress={() => setTemplate(t.name)} accessibilityRole="radio" accessibilityState={{ checked: template === t.name }}
                style={{ minHeight: TAP, padding: 12, borderRadius: radii.key, backgroundColor: template === t.name ? T.raised : "transparent", borderWidth: 1, borderColor: T.line }}>
                <Text style={{ color: T.text }}>{t.name ? `${t.name} — ${t.description}` : t.description}</Text>
              </TouchableOpacity>
            ))}
            {label("WHO WORKS HERE")}
            {agents === null ? <ActivityIndicator color={T.dim} /> : agents.length === 0 ? (
              <Text style={{ color: T.dim, fontSize: 13 }}>No agent CLIs found on your computer — the project starts empty; add one later.</Text>
            ) : agents.map((a) => {
              const p = pick(a.kind);
              return (
                <View key={a.kind} style={{ borderWidth: 1, borderColor: p.on ? T.line2 : T.line, borderRadius: radii.key, backgroundColor: p.on ? T.raised : "transparent" }}>
                  <TouchableOpacity onPress={() => setPick(a.kind, { on: !p.on })} disabled={busy} activeOpacity={0.7}
                    accessibilityRole="checkbox" accessibilityState={{ checked: p.on }}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP, paddingHorizontal: 12 }}>
                    <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: p.on ? T.text : T.faint,
                      backgroundColor: p.on ? T.text : "transparent", alignItems: "center", justifyContent: "center" }}>
                      {p.on && <Text style={{ color: T.bg, fontSize: 13, fontWeight: "900" }}>✓</Text>}
                    </View>
                    <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600", flex: 1 }} numberOfLines={1}>{a.label}</Text>
                    {a.authed === false && <Text style={{ color: T.warn, fontSize: 12 }}>not signed in</Text>}
                  </TouchableOpacity>
                  {p.on && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 10 }}>
                      <TextInput value={p.model} onChangeText={(v) => setPick(a.kind, { model: v })} placeholder={a.kind === "model" ? "model id (needed)" : "default model"} placeholderTextColor={T.faint}
                        autoCapitalize="none" autoCorrect={false} accessibilityLabel={`${a.label} model`}
                        style={{ flex: 1, color: T.text, backgroundColor: T.bg, borderRadius: radii.input, paddingHorizontal: 10, height: 38, fontSize: 13.5 }} />
                      <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: T.line, borderRadius: radii.input }}>
                        <TouchableOpacity onPress={() => setPick(a.kind, { count: Math.max(1, p.count - 1) })} accessibilityLabel="one fewer" style={{ width: 36, height: 38, alignItems: "center", justifyContent: "center" }}>
                          <Text style={{ color: T.text, fontSize: 18 }}>−</Text>
                        </TouchableOpacity>
                        <Text style={{ color: T.text, fontSize: 14, fontWeight: "700", minWidth: 22, textAlign: "center" }} accessibilityLabel={`${p.count} of them`}>×{p.count}</Text>
                        <TouchableOpacity onPress={() => setPick(a.kind, { count: Math.min(8, p.count + 1) })} accessibilityLabel="one more" style={{ width: 36, height: 38, alignItems: "center", justifyContent: "center" }}>
                          <Text style={{ color: T.text, fontSize: 18 }}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
            {agents && agents.length > 0 && <Text style={{ color: T.faint, fontSize: 12, lineHeight: 17 }}>Tick none to use every agent on your computer. Same one twice? Raise the count — each gets its own name.</Text>}
          </View>
        )}

        {progress ? <Text style={{ color: T.dim, fontSize: 12.5, fontFamily: T.mono }} numberOfLines={2}>{progress}</Text> : null}
        {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}

        <TouchableOpacity onPress={() => void create()} disabled={busy} activeOpacity={0.8} accessibilityRole="button"
          style={{ minHeight: TAP, borderRadius: radii.key, backgroundColor: T.bright, alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color={T.onBright} /> : (
            <Text style={{ color: T.onBright, fontSize: 15, fontWeight: "700" }}>{mode === "new" ? "Create project" : "Clone project"}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => void demo()} disabled={busy} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Try a demo project"
          style={{ minHeight: TAP, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}>
          <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600" }}>Try a demo project</Text>
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>Three demo agents, no keys — see Loom work first</Text>
        </TouchableOpacity>
      </ScrollView>
    </Sheet>
  );
}
