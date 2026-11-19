import { useEffect, useRef, useState } from "react";
import { Alert, Linking, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type Creds } from "./api";
import { Btn, DiffView, Sys } from "./components";
import { T } from "./theme";
import { REVIEW_REFRESH_MS, hunkRequest, reviewProgress, viewedRequest, type InboxItem, type ReviewView } from "./r4-review-model";

export function R4Inbox({ creds }: { creds: Creds }) {
  const [items, setItems] = useState<InboxItem[]>([]), [error, setError] = useState("");
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const refresh = () => api<{ items: InboxItem[]; errors: { error: string }[] }>(creds, "/api/review/inbox").then(r => { setItems(r.items); setError(r.errors.map(e => e.error).join("\n")); }).catch(e => setError(e.message));
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), REVIEW_REFRESH_MS); return () => clearInterval(timer); }, [creds]);
  return <View style={{ gap: 8 }}><Text style={{ color: T.text, fontWeight: "700" }}>Review inbox</Text>
    {!!error && <Sys text={error} />}<Btn label="Refresh review inbox" onPress={() => void refresh()} />
    {!items.length && !error && <Text style={{ color: T.dim }}>No unreviewed changes</Text>}
    {items.map(item => <Btn key={item.project + "/" + (item.run || item.chat)} label={`${item.projectName} · ${item.title} · ${reviewProgress(item)}`} onPress={() => setSelected(item)} />)}
    {selected && <><Btn label="Close review" onPress={() => { setSelected(null); void refresh(); }} /><R4ReviewPanel key={selected.project + (selected.run || selected.chat)} creds={creds} id={selected.project} chat={selected.chat} run={selected.run} /></>}
  </View>;
}
export function R4ReviewPanel({ creds, id, chat, run, agent }: { creds: Creds; id: string; chat: string; run?: string; agent?: string }) {
  const root = `/api/projects/${encodeURIComponent(id)}`;
  const scope = run ? `?run=${encodeURIComponent(run)}` : `?chat=${encodeURIComponent(chat)}`;
  const [view, setView] = useState<ReviewView>({ files: [], viewed: 0, total: 0 });
  const [summary, setSummary] = useState<{ path: string; summary: string; flags: string[] }[]>([]);
  const [file, setFile] = useState(""), [line, setLine] = useState("1"), [patch, setPatch] = useState("");
  const [hunks, setHunks] = useState<{ version: string; hunks: { id: string; patch: string }[] }>({ version: "", hunks: [] });
  const [conflicts, setConflicts] = useState<{ files: string[]; waitingForReview: boolean }>({ files: [], waitingForReview: false });
  const [conflictBranch, setConflictBranch] = useState("");
  const [command, setCommand] = useState(""), [output, setOutput] = useState(""), [busy, setBusy] = useState(false), [undo, setUndo] = useState(false);
  const [savedReviews, setSavedReviews] = useState<{ reviewId: string; target: { url: string }; status: string }[]>([]);
  const [pr, setPr] = useState(""), [reviewId, setReviewId] = useState(""), [draft, setDraft] = useState(""), [prUrl, setPrUrl] = useState("");
  const [splitModel, setSplitModel] = useState("");
  const contextKey = creds.url + creds.token + id + chat + (run || ""), activeContext = useRef(contextKey); activeContext.current = contextKey;
  const [groups, setGroups] = useState(""), [splitVersion, setSplitVersion] = useState("");
  const call = <R,>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => api<R>(creds, root + route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function work(fn: () => Promise<unknown>) { setBusy(true); try { await fn(); } catch(e) { setOutput(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function refresh() {
    const [v, s, c] = await Promise.all([call<ReviewView>("/review/viewed" + scope), call<{ files: typeof summary }>("/review/summary" + scope), call<typeof conflicts>("/git/conflicts")]);
    if (activeContext.current === contextKey) { setView(v); setSummary(s.files); setConflicts(c); }
  }
  useEffect(() => { let active = true; setFile(""); setPatch(""); setHunks({ version: "", hunks: [] }); setReviewId(""); setSavedReviews([]); setDraft(""); setGroups(""); setUndo(false); void Promise.all([call<ReviewView>("/review/viewed" + scope), call<{ files: typeof summary }>("/review/summary" + scope), call<{ verify?: string; last?: { output: string; ok: boolean } }>("/git/verify"), call<typeof conflicts>("/git/conflicts")]).then(([v,s,c,conflict]) => { if (active) { setView(v); setSummary(s.files); setCommand(c.verify || ""); setConflicts(conflict); if (c.last) setOutput((c.last.ok ? "Passed\n" : "Commit held\n") + c.last.output); } }).catch(e => { if (active) setOutput(e.message); }); return () => { active = false; }; }, [creds, id, chat, run]);
  useEffect(() => { const timer = setInterval(() => void refresh().catch(() => {}), REVIEW_REFRESH_MS); return () => clearInterval(timer); }, [creds, id, chat, run]);
  async function openFile(name: string, recorded?: string) {
    setFile(name); setLine("1");
    const [diff, h] = await Promise.all([call<{ patch: string }>("/git/diff?path=" + encodeURIComponent(name)), call<typeof hunks>("/git/hunks?path=" + encodeURIComponent(name))]);
    if (activeContext.current === contextKey) { setPatch(recorded || diff.patch); setHunks(h); }
  }
  const input = { color: T.text, backgroundColor: T.raised, padding: 10, borderRadius: 8 };
  return <View style={{ gap: 8 }}><Text style={{ color: T.text, fontWeight: "700" }}>Review changes · {reviewProgress(view)}</Text>
    {!!conflicts.files.length && <Btn label={`Conflicts in ${conflicts.files.length} files · Resolve with agent`} disabled={busy} onPress={() => void work(async () => { const r = await call<{ chat: string }>("/git/resolve", { agent }); setOutput(`Resolution started in chat ${r.chat}. Review the files before committing.`); await refresh(); })} />}
    {conflicts.waitingForReview && <><Text style={{ color: T.dim }}>Resolution waits for your review and manual commit.</Text><Btn label="Release hold" disabled={busy} onPress={() => void work(async () => { await call("/git/resolve", undefined, "DELETE"); await refresh(); })} /></>}
    <Btn label="Refresh changes" disabled={busy} onPress={() => void work(refresh)} />
    {summary.map(s => <Text key={s.path} style={{ color: T.dim }}>{s.summary}{s.flags.length ? "\nAttention: " + s.flags.join(" · ") : ""}</Text>)}
    {view.files.map(f => <View key={f.path} style={{ gap: 4 }}><Btn label={`Open diff: ${f.path}`} onPress={() => void work(() => openFile(f.path, f.patch))} /><Btn label={`${f.viewed ? "✓ Viewed" : "Mark viewed"}: ${f.path}`} disabled={busy} onPress={() => void work(async () => setView(await call<ReviewView>("/review/viewed", viewedRequest(f, chat, run))))} /></View>)}
    <TextInput accessibilityLabel="Review file path" placeholder="path/to/file" placeholderTextColor={T.faint} value={file} onChangeText={setFile} style={input} />
    <Btn label="Open current diff" disabled={busy || !file} onPress={() => void work(() => openFile(file))} />
    {!!patch && <DiffView patch={patch} maxHeight={400} />}
    <TextInput accessibilityLabel="Line to attribute" value={line} keyboardType="number-pad" onChangeText={setLine} style={input} />
    <Btn label="Who wrote this?" disabled={busy || !file} onPress={() => void work(async () => { const r = await call<{ agent?: string; chat?: string; turn?: number; prompt?: string; reason?: string }>("/review/blame?" + new URLSearchParams({ path: file, line })); setOutput(r.agent ? `${r.agent} · chat ${r.chat} · turn ${r.turn}\n${r.prompt}` : r.reason || "No recorded attribution"); })} />
    {hunks.hunks.map(h => <View key={h.id}><DiffView patch={h.patch} maxHeight={220} /><Btn label="Keep hunk (stage)" disabled={busy} onPress={() => void work(async () => { await call("/git/hunks", hunkRequest(file, hunks.version, h.id, "stage")); await openFile(file); })} /><Btn label="Discard hunk" disabled={busy} onPress={() => Alert.alert("Discard this hunk?", "Undo is available until the file changes again.", [{ text: "Cancel", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void work(async () => { await call("/git/hunks", hunkRequest(file, hunks.version, h.id, "discard")); setUndo(true); await openFile(file); }) }])} /></View>)}
    {undo && <Btn label="Undo last discard" disabled={busy} onPress={() => void work(async () => { await call("/git/hunks", { action: "undo" }); setUndo(false); await openFile(file); })} />}
    <TextInput accessibilityLabel="Conflict branch" value={conflictBranch} onChangeText={setConflictBranch} placeholder="Optional branch from Apply or land" placeholderTextColor={T.faint} style={input} />
    <Btn label="Resolve conflicts with agent" disabled={busy} onPress={() => void work(async () => { const r = await call<{ chat: string }>("/git/resolve", { agent, run, branch: conflictBranch || undefined }); setOutput(`Resolution started in chat ${r.chat}. Review the files before committing.`); })} />
    <TextInput accessibilityLabel="Verify before commit command" value={command} onChangeText={setCommand} placeholder="e.g. npm test (empty disables)" placeholderTextColor={T.faint} style={input} />
    <Btn label="Save verification" disabled={busy} onPress={() => void work(async () => { await call("/git/verify", { command }, "PUT"); setOutput("Verification saved"); })} />
    <Btn label="Run verification" disabled={busy} onPress={() => void work(async () => { const r = await call<{ result: { output: string } | null }>("/git/verify", {}); setOutput(r.result?.output || "Verification passed or disabled"); })} />
    <Btn label="Send failure to agent" disabled={busy} onPress={() => void work(async () => { const r = await call<{ chat: string }>("/git/verify/agent", { agent }); setOutput(`Fix started in chat ${r.chat}`); })} />
    <TextInput accessibilityLabel="Optional split model" value={splitModel} onChangeText={setSplitModel} placeholder="Split model (optional)" placeholderTextColor={T.faint} style={input} />
    <Btn label="Propose split commits" disabled={busy} onPress={() => void work(async () => { const r = await call<{ groups: unknown[]; version: string }>("/git/split?model=" + encodeURIComponent(splitModel)); setGroups(JSON.stringify(r.groups, null, 2)); setSplitVersion(r.version); })} />
    {!!groups && <><TextInput accessibilityLabel="Editable commit groups" multiline value={groups} onChangeText={setGroups} style={input} /><Btn label="Apply edited commits" disabled={busy} onPress={() => Alert.alert("Commit these groups?", "Each group becomes a separate commit.", [{ text: "Cancel" }, { text: "Commit", onPress: () => void work(async () => { const r = await call<{ commits: unknown[] }>("/git/split", { groups: JSON.parse(groups), version: splitVersion }); setOutput(`${r.commits.length} commits created`); setGroups(""); }) }])} /></>}
    <TextInput accessibilityLabel="Pull request number or URL" value={pr} onChangeText={setPr} placeholder="PR number or URL" placeholderTextColor={T.faint} style={input} />
    <Btn label="Review pull request" disabled={busy || !pr} onPress={() => void work(async () => { const r = await call<{ review: { reviewId: string }; target: { url: string } }>("/review/pr", { pr, agents: agent ? [agent] : [] }); setReviewId(r.review.reviewId); setPrUrl(r.target.url); setOutput("Review started. Load comments when ready."); })} />
    <Btn label="Load saved PR reviews" disabled={busy} onPress={() => void work(async () => setSavedReviews((await call<{ reviews: typeof savedReviews }>("/review/pr")).reviews))} />
    {savedReviews.map(r => <Btn key={r.reviewId} label={`${r.target.url} · ${r.status}`} onPress={() => { setReviewId(r.reviewId); setPrUrl(r.target.url); setDraft(""); }} />)}
    {!!reviewId && <Btn label="Load draft comments" disabled={busy} onPress={() => void work(async () => { const r = await call<{ draft: string; review: { status: string } }>("/review/pr/" + reviewId); setDraft(r.draft); setOutput(r.review.status); })} />}
    {!!draft && <><TextInput accessibilityLabel="Editable PR comments" multiline value={draft} onChangeText={setDraft} style={input} /><Btn label="Save draft comments" onPress={() => void work(() => call("/review/pr/" + reviewId, { text: draft }, "PUT"))} /><Btn label="Copy comments to post yourself" onPress={() => void Clipboard.setStringAsync(draft)} />{prUrl.startsWith("https://") && <Btn label="Open pull request" onPress={() => void Linking.openURL(prUrl)} />}</>}
    {!!output && <Sys text={output} />}
  </View>;
}
