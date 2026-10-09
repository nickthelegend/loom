/**
 * Artifact previews: a short-lived link to a file an agent made, served from
 * its own folder only, always under a CSP sandbox; and project images for the
 * thread, behind the bearer wall.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let base: string;
let token: string;
let pid: string;
let dir: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-artifacts");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  base = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  token = cfg.adminToken;
  dir = makeProjectDir({ name: "arts" });
  fs.mkdirSync(path.join(dir, "site"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site", "index.html"), "<h1>hi</h1><link rel=stylesheet href=s.css>");
  fs.writeFileSync(path.join(dir, "site", "s.css"), "h1{color:red}");
  fs.writeFileSync(path.join(dir, "secret.txt"), "not for previews");
  fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from("iVBORw0KGgo=", "base64"));
  pid = (await new DaemonClient(cfg).addProject(dir)).project.id;
});
afterAll(async () => { await daemon.close(); });

const mint = (p: string) => fetch(`${base}/api/projects/${pid}/preview`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path: p }),
});

describe("artifact preview links", () => {
  it("serve the page and its relative assets under a sandbox, and nothing outside its folder", async () => {
    const { url } = (await (await mint("site/index.html")).json()) as { url: string };
    expect(url).toMatch(/^\/preview\/[\w-]+\/index\.html$/);
    const page = await fetch(base + url); // no token: the link is the credential
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toMatch(/^sandbox /);
    expect(page.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(await page.text()).toContain("<h1>hi</h1>");
    const css = await fetch(base + url.replace("index.html", "s.css"));
    expect(css.headers.get("content-type")).toContain("text/css");
    // the folder above, by traversal or encoded traversal: refused
    for (const bad of ["../secret.txt", "..%2fsecret.txt", "%2e%2e/secret.txt"]) {
      const r = await fetch(base + url.replace("index.html", bad));
      expect([401, 404]).toContain(r.status); // a URL-normalised ../ misses the route entirely and meets the auth wall
      expect(await r.text()).not.toContain("not for previews");
    }
    expect((await fetch(`${base}/preview/not-a-token/index.html`)).status).toBe(410);
  });

  it("minting needs the bearer token and a file that exists in the project", async () => {
    expect((await fetch(`${base}/api/projects/${pid}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await mint("nope.html")).status).toBe(404);
    expect((await mint("../../etc/passwd")).status).toBe(404);
  });
});

describe("project images for the thread", () => {
  it("serves images in the project only, behind the token", async () => {
    const ok = await fetch(`${base}/api/projects/${pid}/image?path=shot.png`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/api/projects/${pid}/image?path=shot.png`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/${pid}/image?path=secret.txt`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/${pid}/image?path=../../x.png`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });
});
