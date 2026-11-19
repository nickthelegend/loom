import { R4ReviewPanel } from "./r4-review";
import { gitDraftRequest, type GitDraftKind } from "./git-review-model";
import { useEffect, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, type Creds, type Checkpoint } from "./api";
import { Btn, Sys } from "./components";
import { T } from "./theme";

/** Git drafts stay editable on the phone; nothing is published by drafting. */
export function GitReviewPanel(props: { creds: Creds; id: string; chat: string; agent?: string; checkpoints: Checkpoint[]; onMessage: (message: string) => void; onRewind: () => void }) {
  const { creds, id, chat } = props;
  const [templates, setTemplates] = useState<Record<string, string[]>>({});
  const [template, setTemplate] = useState("standard");
  const [branch, setBranch] = useState("");
  const [branchPerChat, setBranchPerChat] = useState(false);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = `/api/projects/${id}`;
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<{ templates: Record<string, string[]> }>(creds, root + "/git/review-templates"),
      api<{ git?: { branchPerChat?: boolean; messageModel?: string } }>(creds, root + "/config"),
    ]).then(([t, c]) => { if (live) { setTemplates(t.templates); setBranchPerChat(Boolean(c.git?.branchPerChat)); setModel(c.git?.messageModel ?? ""); } }).catch(e => { if (live) setError(String(e.message)); });
    return () => { live = false; };
  }, [creds, root]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const post = <T,>(route: string, body: unknown) => api<T>(creds, root + route, { method: "POST", body: JSON.stringify(body) });
  async function makeDraft(kind: GitDraftKind) {
    const request = gitDraftRequest(kind, chat, template, branch);
    const result = await post<Record<string, string>>(request.route, request.body);
    if (kind === "message") props.onMessage(result[request.field]!);
    else setDraft(result[request.field]!);
  }
  const input = { color: T.text, backgroundColor: T.raised, padding: 10, borderRadius: 8 };
  return <View style={{ gap: 8 }}>
    <R4ReviewPanel creds={creds} id={id} chat={chat} agent={props.agent} />
    <Text style={{ color: T.text, fontWeight: "700" }}>Git and review</Text>
    {!!error && <Sys text={error} />}
    <Btn label="Generate commit message" disabled={busy} onPress={() => void run(() => makeDraft("message"))} />
    <Btn label={branchPerChat ? "Branch per chat: on" : "Branch per chat: off"} disabled={busy} onPress={() => void run(async () => {
      await api(creds, root + "/config", { method: "PATCH", body: JSON.stringify({ git: { branchPerChat: !branchPerChat } }) }); setBranchPerChat(!branchPerChat);
    })} />
    <TextInput accessibilityLabel="Commit message model" placeholder="Message model (empty uses template)" placeholderTextColor={T.faint} value={model} onChangeText={setModel} style={input} />
    <Btn label="Save message model" disabled={busy} onPress={() => void run(() => api(creds, root + "/config", { method: "PATCH", body: JSON.stringify({ git: { messageModel: model } }) }))} />
    <Text style={{ color: T.dim }}>Review checklist</Text>
    {Object.keys(templates).map(name => <Btn key={name} label={`${name === template ? "✓ " : ""}${name}`} onPress={() => setTemplate(name)} />)}
    {(templates[template] ?? []).map(item => <Text key={item} style={{ color: T.dim }}>☐ {item}</Text>)}
    <Btn label="Draft PR description" disabled={busy} onPress={() => void run(() => makeDraft("pr"))} />
    {props.agent && <Btn label={`Review with ${props.agent}`} disabled={busy} onPress={() => void run(async () => {
      const r = await post<{ review: { chat: string } }>("/reviews", { agents: [props.agent], template });
      setDraft(`Review started in chat ${r.review.chat}.\n\n${(templates[template] ?? []).map(c => "☐ " + c).join("\n")}`);
    })} />}
    <TextInput accessibilityLabel="Merged branch" placeholder="Merged branch" placeholderTextColor={T.faint} value={branch} onChangeText={setBranch} style={input} />
    <Btn label="Suggest CHANGELOG" disabled={busy || !branch.trim()} onPress={() => void run(() => makeDraft("changelog"))} />
    {!!draft && <><TextInput accessibilityLabel="Git draft" multiline value={draft} onChangeText={setDraft} style={input} /><Btn label="Copy draft" onPress={() => void Clipboard.setStringAsync(draft)} /></>}
    <Text style={{ color: T.dim }}>Revert one file from a turn</Text>
    {props.checkpoints.slice(0, 12).map(cp => <Btn key={cp.id} label={`${checkpoint === cp.id ? "✓ " : ""}${cp.label}`} onPress={() => setCheckpoint(cp.id)} />)}
    <TextInput accessibilityLabel="File to revert" placeholder="path/to/file" placeholderTextColor={T.faint} value={file} onChangeText={setFile} style={input} />
    <Btn label="Revert file" disabled={busy || !checkpoint || !file.trim()} onPress={() => Alert.alert("Revert this file?", `${file} will be restored from the selected checkpoint. An undo checkpoint is saved first.`, [
      { text: "Cancel", style: "cancel" }, { text: "Revert file", style: "destructive", onPress: () => void run(async () => { await post(`/checkpoints/${encodeURIComponent(checkpoint)}/rewind-file`, { path: file }); props.onRewind(); }) },
    ])} />
  </View>;
}
