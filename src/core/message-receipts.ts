import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

interface Receipt { fingerprint: string; result?: unknown }
const active = new Map<string, Promise<unknown>>();
export class DeliveryConflict extends Error {}

/** Reserve before sending: after a crash an uncertain delivery needs review, never a blind retry. */
export async function deliverOnce(dir: string, identity: string, key: string, body: unknown, send: () => Promise<unknown>): Promise<unknown> {
  const id = createHash("sha256").update(identity + "\0" + key).digest("hex");
  const file = path.join(dir, ".loom", "message-receipts", id + ".json");
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (fs.existsSync(file)) {
    let saved: Receipt;
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")) as Receipt; }
    catch { throw new DeliveryConflict("Delivery receipt is unreadable. Check the chat before sending again."); }
    if (saved.fingerprint !== fingerprint) throw new DeliveryConflict("This delivery id was already used for another message.");
    if (active.has(file)) return active.get(file)!;
    if (Object.hasOwn(saved, "result")) return saved.result;
    throw new DeliveryConflict("Delivery is uncertain after a restart. Check the chat before sending again.");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fingerprint }), { mode: 0o600, flush: true });
  const promise = Promise.resolve().then(send).then(result => {
    fs.writeFileSync(file + ".tmp", JSON.stringify({ fingerprint, result }), { mode: 0o600, flush: true });
    fs.renameSync(file + ".tmp", file);
    return result;
  }).finally(() => active.delete(file));
  active.set(file, promise);
  return promise;
}
