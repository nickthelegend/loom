/**
 * Crash guards for a long-running daemon.
 *
 * The daemon holds every project's runtime, every PTY, and every connected
 * client. Node terminates the process on an unhandled rejection, so before
 * this existed one stray promise anywhere — an adapter, a `gh` call, a push —
 * took all of that down at once. And because `loom up` spawned it with
 * stdio:"ignore", it did so without leaving a single byte to read.
 *
 * The trade is deliberate: a daemon that survives a bad turn is worth more
 * than one that exits cleanly on it. Nothing here swallows quietly — every
 * caught fault is written where `loom up` is pointing (~/.loom/daemon.log).
 */

import { logbook } from "../core/logbook.js";

/**
 * Write a fault the same way whichever kind it is.
 *
 * Through the logbook, so it reaches the Console tab as well as the log file.
 * A daemon that survives a fault silently is only half the fix — you'd never
 * know the turn you're waiting on already died.
 */
function report(kind: string, detail: unknown): void {
  const message = detail instanceof Error ? detail.message : String(detail);
  logbook.error("daemon", `${kind}: ${message}`, detail);
}

/**
 * Keep the process alive through faults it would otherwise die on.
 * Returns a teardown so tests can install and remove it.
 */
export function installCrashGuards(): () => void {
  const onRejection = (reason: unknown): void => report("unhandled rejection", reason);
  const onException = (err: Error): void => report("uncaught exception", err);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
