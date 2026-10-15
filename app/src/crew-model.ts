/** Pure action/state rules shared by the phone view and its acceptance tests. */
export function crewControls(goal: { status: string; recovery?: string; pr?: unknown } | undefined): string[] {
  if (!goal) return [];
  const controls: string[] = [];
  if (["planning", "running", "awaiting_approval", "waiting_team"].includes(goal.status)) controls.push("pause");
  if (["planning", "running", "waiting_human", "awaiting_approval", "waiting_team", "paused"].includes(goal.status)) controls.push("stop");
  if (["interrupted", "stopped", "failed", "paused"].includes(goal.status) && !goal.recovery) controls.push("resume");
  if (goal.status === "awaiting_approval") controls.push("approve");
  if (goal.status === "completed" && !goal.pr && !goal.recovery) controls.push("deliver");
  return controls;
}
export function crewSeatActivity(crew: { active?: Array<{ teammate: string; card?: string; step: string }> }, seat: string) {
  return crew.active?.find(turn => turn.teammate === seat);
}
export function runnerCrewControls(job: { mine: boolean; state: string; progress: { status: string; crew?: unknown } | null }): string[] {
  if (!job.mine || job.state !== "claimed" || !job.progress?.crew) return [];
  const status = job.progress.status;
  return status === "awaiting_approval" ? ["approve", "stop"] : status === "paused" ? ["resume", "stop"]
    : ["planning", "running", "waiting_team"].includes(status) ? ["pause", "stop"] : ["stop"];
}
