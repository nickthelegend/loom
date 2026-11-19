import { useEffect, useState, type ComponentProps } from "react";
import { AppState, Modal, ScrollView, View } from "react-native";
import { BoardScreen } from "../screens";
import { phoneApi as api, listMachines, switchMachine, type Creds, type Project } from "../api";
import { credsOf, type Machine } from "../machines-model";
import { T } from "../theme";
import { acrossMachines, yesterday } from "./model";
import { useLastReplyError } from "./replies";
import { Text } from "./preferences";
import { Button, PhoneSettings } from "./settings";
interface Row { id: string; projectId: string; project: string; chat: string; kind: string; title: string }
interface Now { rows: Row[]; errors: Array<{ projectId: string; error: string }> }
interface Brief { finishedTurns: number; spend: number; prs: unknown[]; prError?: string }
export function PhoneBoard(props: ComponentProps<typeof BoardScreen> & { onMachineOpen: (creds: Creds, project: Project, chat: { id: string; title: string }) => void }) {
  const replyError = useLastReplyError();
  const [panel, setPanel] = useState<"now" | "settings" | null>(null), [rows, setRows] = useState<Array<{ machine: Machine; data: Now | null; error: string | null }>>([]);
  const [brief, setBrief] = useState({ turns: 0, spend: 0, prs: 0, errors: [] as string[], loaded: false }), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => { const { machines } = await listMachines(); const next = await acrossMachines(machines, m => api<Now>(credsOf(m) as Creds, "/api/phone/now")); if (live) setRows(next); };
    void load().catch(e => live && setError(String(e))); const timer = setInterval(() => void load().catch(() => {}), 15000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const { machines } = await listMachines(), range = yesterday();
      const results = await acrossMachines(machines, async m => {
        const c = credsOf(m) as Creds, { projects } = await api<{ projects: Project[] }>(c, "/api/projects");
        return acrossMachines(projects, p => api<Brief>(c, `/api/projects/${p.id}/phone/brief?start=${range.start}&end=${range.end}`));
      });
      const total = { turns: 0, spend: 0, prs: 0, errors: [] as string[], loaded: true };
      for (const r of results) {
        if (r.error) total.errors.push(`${r.machine.name}: ${r.error}`);
        for (const p of r.data ?? []) {
          if (p.error) total.errors.push(`${r.machine.name} · ${p.machine.name}: ${p.error}`);
          if (p.data) { total.turns += p.data.finishedTurns; total.spend += p.data.spend; total.prs += p.data.prs.length; if (p.data.prError) total.errors.push(`${r.machine.name}: ${p.data.prError}`); }
        }
      }
      if (live) setBrief(total);
    };
    void load().catch(e => live && setError(String(e))); const timer = setInterval(() => void load().catch(() => {}), 15 * 60000);
    const sub = AppState.addEventListener("change", state => { if (state === "active") void load().catch(e => live && setError(String(e))); });
    return () => { live = false; clearInterval(timer); sub.remove(); };
  }, []);
  const open = async (m: Machine, row: Row) => {
    try {
      const c = credsOf(m) as Creds, { project } = await api<{ project: Project }>(c, `/api/projects/${row.projectId}`);
      const active = await switchMachine(m.id); if (!active || active.token !== c.token) throw new Error("Pairing changed. Refresh Now.");
      setPanel(null); props.onMachineOpen(c, project, { id: row.chat, title: row.title });
    } catch (e) { setError(String(e)); }
  };
  return <View style={{ flex: 1 }}>
    <View style={{ backgroundColor: T.panel, padding: 8, borderBottomWidth: 1, borderColor: T.line }}>
      <View style={{ flexDirection: "row" }}><Button title={`Now · ${rows.reduce((n, r) => n + (r.data?.rows.length ?? 0), 0)}`} onPress={() => setPanel("now")} /><Button title="Phone preferences" onPress={() => setPanel("settings")} /></View>
      <Text style={{ color: T.text }}>Morning brief · {brief.loaded ? `Yesterday: ${brief.turns} finished turns · $${brief.spend.toFixed(2)} · ${brief.prs} PRs waiting` : "Loading…"}</Text>
      {!!replyError && <Text accessibilityRole="alert" style={{ color: T.err }}>{replyError}</Text>}
      {brief.errors.map((e, i) => <Text key={i} style={{ color: T.warn }}>{e}</Text>)}
    </View>
    <BoardScreen {...props} />
    <Modal visible={panel !== null} animationType="slide" onRequestClose={() => setPanel(null)}><View style={{ flex: 1, backgroundColor: T.bg, paddingTop: 40 }}><Button title="Back to Board" onPress={() => setPanel(null)} /><Text style={{ color: T.err }}>{error}</Text>
      {panel === "settings" ? <PhoneSettings creds={props.creds} /> : <ScrollView contentContainerStyle={{ padding: 16 }}><Text style={{ color: T.text, fontSize: 24 }}>Now</Text>
        {rows.map(({ machine, data, error: failure }) => <View key={machine.id} style={{ marginVertical: 12 }}><Text style={{ color: T.text, fontSize: 18 }}>{machine.name}</Text>
          {failure && <Text style={{ color: T.warn }}>{failure}</Text>}{data?.errors.map(e => <Text key={e.projectId} style={{ color: T.warn }}>{e.error}</Text>)}
          {data && !data.rows.length && <Text style={{ color: T.dim }}>Nothing needs attention</Text>}
          {data?.rows.map(row => <Button key={`${row.projectId}:${row.id}`} title={`${row.kind} · ${row.project} · ${row.title}`} onPress={() => void open(machine, row)} />)}
        </View>)}
      </ScrollView>}
    </View></Modal>
  </View>;
}
