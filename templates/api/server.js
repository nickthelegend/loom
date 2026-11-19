import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
export function handler(req, res) {
  res.setHeader("content-type", "application/json");
  res.statusCode = req.url === "/health" ? 200 : 404;
  res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { error: "not found" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer(handler).listen(Number(process.env.PORT || 3000), "127.0.0.1");
