/**
 * Get started on the phone (#403): the same checklist as the computer's Home, from
 * GET /api/onboarding. What the phone can do it does here — try the demo, start a project, open one
 * to send the first message; the rest names where to do it on the computer. Hidden once every
 * required step is done, or when it was hidden on the computer.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { getOnboarding, tryDemo, type Creds, type OnboardingStep } from "./api";
import { TAP } from "./components";
import { T, radii, spacing } from "./theme";

const ON_COMPUTER: Record<string, string> = {
  "install-agent": "On your computer: Settings ▸ Setup installs them in one click.",
  "run-fleet": "Open a project ▸ Orchestra, pick a fleet and give it a goal.",
  skills: "On your computer: Settings ▸ Loom for agents.",
  share: "On your computer: share a chat, or invite someone from Team.",
};

export function GetStartedCard(props: {
  creds: Creds;
  /** Bumped by the board's refresh so a step you just finished ticks itself. */
  refreshKey: number;
  hasProjects: boolean;
  onNewProject: () => void;
  onOpenFirst: () => void;
  onProjectCreated: (id: string) => void;
}) {
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The board refreshes every few seconds; the checklist reads every project, so at most twice a minute.
  const last = useRef(0);
  useEffect(() => {
    if (Date.now() - last.current < 30_000 && steps) return;
    last.current = Date.now();
    let gone = false;
    void getOnboarding(props.creds)
      .then((r) => { if (gone) return; setSteps(r.steps.filter((s) => !s.optional)); setHidden(r.dismissed); })
      .catch(() => { if (!gone) setHidden(true); }); // an older computer: no card
    return () => { gone = true; };
  }, [props.creds.url, props.refreshKey]);

  if (hidden || !steps || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)!;

  const go = async (s: OnboardingStep) => {
    setErr(null);
    if (s.action === "try") {
      setBusy(true);
      try { const { project } = await tryDemo(props.creds); props.onProjectCreated(project.id); }
      catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    } else if (s.action === "open-project") props.onNewProject();
    else if (s.action === "send-message" && props.hasProjects) props.onOpenFirst();
    else setOpen(true);
  };
  const phoneCan = (s: OnboardingStep) => s.action === "try" || s.action === "open-project" || (s.action === "send-message" && props.hasProjects);

  return (
    <View style={{ borderWidth: 1, borderColor: T.line, borderRadius: 14, backgroundColor: T.panel, padding: spacing.md, gap: 10 }}>
      <TouchableOpacity onPress={() => setOpen((o) => !o)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Get started, ${done} of ${steps.length} done`}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: T.text, fontSize: 15, fontWeight: "700", flex: 1 }}>Get started</Text>
        <Text style={{ color: T.dim, fontSize: 12.5, fontWeight: "600" }}>{done} of {steps.length}</Text>
        <Text style={{ color: T.dim, fontSize: 16 }}>{open ? "⌃" : "⌄"}</Text>
      </TouchableOpacity>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: T.raised, overflow: "hidden" }}>
        <View style={{ width: `${Math.round((100 * done) / steps.length)}%`, height: 4, backgroundColor: T.thread }} />
      </View>
      {(open ? steps : [next]).map((s) => (
        <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, opacity: s.done ? 0.55 : 1 }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: s.done ? T.ok : s === next ? T.thread : T.line2,
            backgroundColor: s.done ? T.ok : "transparent", alignItems: "center", justifyContent: "center" }}>
            {s.done && <Text style={{ color: T.bg, fontSize: 11, fontWeight: "900" }}>✓</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>{s.title}</Text>
            <Text style={{ color: T.dim, fontSize: 12, marginTop: 1 }} numberOfLines={2}>{s.done ? s.detail : phoneCan(s) ? s.detail : ON_COMPUTER[s.action] ?? s.detail}</Text>
          </View>
          {!s.done && phoneCan(s) && (
            <TouchableOpacity onPress={() => void go(s)} disabled={busy} activeOpacity={0.8} accessibilityRole="button"
              style={{ minHeight: TAP - 10, paddingHorizontal: 12, borderRadius: radii.key, backgroundColor: s === next ? T.bright : T.raised, justifyContent: "center" }}>
              {busy && s.action === "try" ? <ActivityIndicator color={T.onBright} /> : (
                <Text style={{ color: s === next ? T.onBright : T.text, fontSize: 13, fontWeight: "700" }}>
                  {s.action === "try" ? "Try the demo" : s.action === "open-project" ? "New project" : "Open"}
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      ))}
      {err && <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text>}
    </View>
  );
}
