/**
 * `loom route` without --detach: follow the route it started until it ends.
 *
 * The route starts before the CLI subscribes, and the event feed has no replay. A first step that
 * can't start (quarantined, over budget) fails the route inside the start call — its route_failed
 * went out before anyone was listening, and the CLI waited for it forever. So: a route that comes
 * back already over is over, and the feed is backed by polling the route's state, which also
 * closes the gap between starting it and subscribing.
 */

import type { LoomEvent, RouteState } from "../types.js";

const OVER = new Set(["completed", "failed", "aborted"]);

export interface RouteFollowClient {
  subscribe(onEvent: (projectId: string, event: LoomEvent) => void, projectId?: string): () => void;
  routeState(projectId: string): Promise<{ route: RouteState | null }>;
}

/** Resolves with the route's final state (null if it vanished); `onEvent` sees the live feed meanwhile. */
export async function followRoute(
  client: RouteFollowClient,
  projectId: string,
  started: RouteState,
  onEvent: (e: LoomEvent) => void,
  pollMs = 2000,
): Promise<RouteState | null> {
  if (OVER.has(started.status)) return started;
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<RouteState | null>((resolve) => {
      let done = false;
      const finish = (r: RouteState | null) => {
        if (!done) { done = true; resolve(r); }
      };
      // Over, or replaced by another route: either way the one we started is done.
      const check = () =>
        void client.routeState(projectId).then(({ route }) => {
          if (!route || route.id !== started.id || OVER.has(route.status)) finish(route);
        }).catch(() => {});
      let lastSeen = 0;
      unsubscribe = client.subscribe((pid, e) => {
        if (pid !== projectId || e.id <= lastSeen) return;
        lastSeen = e.id;
        onEvent(e);
        if (e.kind === "route_completed" || e.kind === "route_failed") check();
      }, projectId);
      check();
      timer = setInterval(check, pollMs);
    });
  } finally {
    if (timer) clearInterval(timer);
    unsubscribe();
  }
}
