import { useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { api, type Creds } from "./api";
import { Btn } from "./components";
import { Sheet } from "./observatory";
import { T } from "./theme";
import { safetyPatterns, safetyPreset, type SafetyPolicy, type SafetyPreset } from "./safety-model";

export async function withSecretRetry<T>(operation: "commit" | "push", run: (override: boolean) => Promise<T>): Promise<T> {
  try { return await run(false); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Secret scan blocked")) throw error;
    const message = error.message;
    const yes = await new Promise<boolean>(resolve => Alert.alert("Secrets detected", message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: `Override and ${operation}`, style: "destructive", onPress: () => resolve(true) },
    ], { cancelable: false }));
    if (!yes) throw error;
    return run(true);
  }
}

const fields = [["allow", "Allow tools (globs)"], ["deny", "Deny tools (deny wins)"], ["protectedPaths", "Protected paths (relative globs)"], ["shellDeny", "Shell denylist (globs)"]] as const;
export function SafetyButton({ creds, projectId, onChanged }: { creds: Creds; projectId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<SafetyPolicy | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [minutes, setMinutes] = useState("30");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState("");
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/safety`;
  const fill = (p: SafetyPolicy) => { setPolicy(p); setMinutes(String(p.approvalTimeoutMin)); setDrafts(Object.fromEntries(fields.map(([key]) => [key, p[key].join("\n")]))); };
  const load = async () => {
    setOpen(true); setError(""); setPolicy(null); setAudit("");
    try { fill((await api<{ policy: SafetyPolicy }>(creds, endpoint)).policy); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  };
  const save = async () => {
    if (!policy || busy) return;
    setBusy(true); setError("");
    try {
      const next = { ...policy, approvalTimeoutMin: Number(minutes), ...Object.fromEntries(fields.map(([key]) => [key, safetyPatterns(drafts[key] ?? "")])) };
      await api(creds, endpoint, { method: "PUT", body: JSON.stringify(next) });
      onChanged(); setOpen(false);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };
  return <>
    <Btn label="Safety" small onPress={() => void load()} />
    <Sheet title="Project safety" visible={open} onClose={() => setOpen(false)}>
      <Text style={{ color: T.dim }}>Protected paths disable shells and tools that cannot enforce them. Secrets are scanned before Loom commits and pushes; transcripts and exports redact credentials.</Text>
      {policy ? <>
        <Text style={{ color: T.text }}>Preset: {policy.preset}. Applies to every agent.</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>{(["strict", "normal", "trusting"] as SafetyPreset[]).map(p => <Btn key={p} label={p} small onPress={() => fill(safetyPreset(p))} />)}</View>
        {fields.map(([key, label]) => <View key={key} style={{ gap: 4 }}>
          <Text style={{ color: T.text }}>{label}</Text>
          <TextInput accessibilityLabel={label} multiline value={drafts[key]} onChangeText={text => setDrafts({ ...drafts, [key]: text })} placeholder="One pattern per line" placeholderTextColor={T.dim} style={{ color: T.text, borderColor: T.line, borderWidth: 1, borderRadius: 8, padding: 8, minHeight: 55 }} />
        </View>)}
        <Text style={{ color: T.text }}>Auto-deny after minutes</Text>
        <TextInput accessibilityLabel="Auto-deny after minutes" value={minutes} keyboardType="decimal-pad" onChangeText={setMinutes} style={{ color: T.text, borderColor: T.line, borderWidth: 1, padding: 8 }} />
        <Btn label={busy ? "Saving…" : "Save policy"} primary onPress={() => void save()} />
        <Btn label="Risky audit (owner)" onPress={() => {
          void api<{ entries: Array<{ project: string; at: number; who: string; what: string; detail?: string }> }>(creds, "/api/audit?risky=true").then(j => setAudit(j.entries.filter(e => e.project === projectId).map(e => `${new Date(e.at).toLocaleString()} · ${e.who} · ${e.what}\n${e.detail ?? ""}`).join("\n\n") || "No risky activity recorded.")).catch(e => setError(e.message));
        }} />
      </> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: T.err }}>{error}</Text> : null}
      {audit ? <Text selectable style={{ color: T.text }}>{audit}</Text> : null}
    </Sheet>
  </>;
}
