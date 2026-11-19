export type SafetyPreset = "strict" | "normal" | "trusting";
export interface SafetyPolicy {
  preset: SafetyPreset;
  allow: string[];
  deny: string[];
  protectedPaths: string[];
  shellDeny: string[];
  approvalTimeoutMin: number;
}
export function safetyPreset(preset: SafetyPreset): SafetyPolicy {
  return { preset, allow: [], deny: [], shellDeny: [], protectedPaths: preset === "strict" ? [".env", ".env.*", ".git/**", ".loom/**"] : [], approvalTimeoutMin: { strict: 5, normal: 30, trusting: 60 }[preset] };
}
export function permissionIndicator(kind: string, mode: string): string {
  if (mode === "bypass") return kind === "codex" ? "Bypass · no sandbox" : "Bypass · no approvals";
  if (kind === "codex") return mode === "auto" ? "Auto · workspace sandbox" : "Ask · read-only sandbox";
  return `${mode === "ask" ? "Ask" : "Auto"} · tool permissions`;
}
export function safetyPatterns(text: string): string[] { return text.split("\n").map(v => v.trim()).filter(Boolean); }
