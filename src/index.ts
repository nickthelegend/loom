/**
 * Loom — library entry point.
 * Everything a programmatic consumer (or the future iOS app's dev tooling)
 * needs to talk to a loom daemon or embed the core.
 */

export * from "./types.js";
export { EventLog } from "./core/eventlog.js";
export { BatonManager, NotHolderError } from "./core/baton.js";
export { buildBriefing, buildProjection } from "./core/projection.js";
export { buildUnifiedMemory, readNativeMemory, nativeMemoryFiles } from "./core/memory.js";
export { suggestHandoff } from "./core/suggestions.js";
export { RouteEngine, RouteActiveError, resolveSteps, stepName } from "./core/routes.js";
export { rulesRouter, llmRouter } from "./core/router.js";
export type { HopDecision, RouterContext } from "./core/router.js";
export { renderProjection } from "./core/distill.js";
export { claudeText } from "./core/claude-cli.js";
export {
  listProjects,
  findProject,
  registerProject,
  readProjectConfig,
  writeProjectConfig,
  loomHome,
} from "./core/registry.js";
export { ProjectRuntime } from "./daemon/runtime.js";
export { LoomDaemon, DEFAULT_PORT, tailscaleIp } from "./daemon/server.js";
export { DaemonClient, ensureDaemon, daemonRunning, stopDaemon } from "./daemon/client.js";
