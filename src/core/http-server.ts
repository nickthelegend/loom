import type { Server } from "node:http";

/** A client can be blocked in synchronous Git/CLI work longer than Node's
 * five-second idle default. Keep its pooled socket alive through that work
 * so the next request cannot race a delayed close notification on Windows. */
export function configureHttpServer(server: Server): void {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
}
