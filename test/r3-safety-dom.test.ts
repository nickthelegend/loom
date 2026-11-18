import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { requestApproval } from "../src/core/approvals.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, id: string, dir: string;
const mounted: Array<() => void> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { port } = await daemon.listen(); base = `http://127.0.0.1:${port}`;
  const cfg = readDaemonConfig()!; token = cfg.adminToken; client = new DaemonClient(cfg);
  dir = makeProjectDir({ name: "Safety DOM" });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  id = (await client.addProject(dir)).project.id;
});
afterEach(() => { while (mounted.length) mounted.pop()!(); });
afterAll(async () => { await daemon.close(); });

// The same small browser capability shim as app-orchestra-dom, with real HTTP and WS.
function mount(desktop = true) {
  const sockets: WebSocket[] = [], errors: string[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const vc = new VirtualConsole(); vc.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, {
    url: `${base}/app#p/${id}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q) ? desktop : false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), base), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.confirm = () => true;
    },
  });
  mounted.push(() => { closed = true; sockets.forEach(s => { s.on("error", () => {}); s.close(); }); dom.window.close(); });
  return { w: dom.window, errors };
}

it.each([true, false])("edits real project safety settings in the %s desktop layout and renders escaped values", async desktop => {
  await client.safety(id, { preset: "normal" });
  const { w, errors } = mount(desktop);
  await waitUntil(() => !!w.document.querySelector("#safety-open"));
  (w.document.querySelector("#safety-open") as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#safety-save"));
  const deny = w.document.querySelector("#safety-deny") as HTMLTextAreaElement;
  deny.value = 'mcp__*\n<img src=x onerror=alert(1)>';
  (w.document.querySelector("#safety-timeout") as HTMLInputElement).value = "7";
  (w.document.querySelector("#safety-save") as HTMLButtonElement).click();
  await waitUntil(() => !w.document.querySelector("#safety-save"));
  expect((await client.safety(id)).policy).toMatchObject({ deny: ['mcp__*', '<img src=x onerror=alert(1)>'], approvalTimeoutMin: 7 });
  (w.document.querySelector("#safety-open") as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#safety-deny"));
  expect((w.document.querySelector("#safety-deny") as HTMLTextAreaElement).value).toContain("<img");
  expect(w.document.querySelector(".safety-modal img")).toBeNull();
  (w.document.querySelector("#safety-audit") as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#safety-report")?.textContent);
  expect(errors).toEqual([]);
});

it("displays preset defaults and validation errors without closing the editor", async () => {
  const { w } = mount();
  await waitUntil(() => !!w.document.querySelector("#safety-open")); (w.document.querySelector("#safety-open") as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#safety-preset"));
  const preset = w.document.querySelector("#safety-preset") as HTMLSelectElement; preset.value = "strict"; preset.dispatchEvent(new w.Event("change", { bubbles: true }));
  expect((w.document.querySelector("#safety-protectedPaths") as HTMLTextAreaElement).value).toContain(".env");
  (w.document.querySelector("#safety-timeout") as HTMLInputElement).value = "0";
  (w.document.querySelector("#safety-save") as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#safety-error")?.textContent);
  expect(w.document.querySelector("#safety-error")!.textContent).toContain("approvalTimeoutMin");
});

it("shows redacted approval input and an explicit expiry in the thread", async () => {
  await client.safety(id, { preset: "normal", approvalTimeoutMin: 1 });
  const { w } = mount();
  await waitUntil(() => !!w.document.querySelector("#box"));
  const ctl = new AbortController(); const secret = "ghp_" + "Q".repeat(36);
  const decision = requestApproval({ project: id, agent: "execbot", tool: "Bash", input: { command: `echo ${secret}` }, signal: ctl.signal });
  try {
    await waitUntil(() => !!w.document.querySelector(".apcard"));
    const text = w.document.querySelector(".apcard")!.textContent!;
    expect(text).toContain("Auto-denies at"); expect(text).not.toContain(secret); expect(text).toContain("[REDACTED]");
  } finally { ctl.abort(); await decision; }
});

it("keeps a permission explanation visible in the composer", async () => {
  const { w } = mount();
  await waitUntil(() => !!w.document.querySelector("#cpermission-status")?.textContent);
  const chip = w.document.querySelector("#cpermission-status") as HTMLElement;
  expect(chip.classList.contains("devonly")).toBe(false);
  expect(chip.style.display).not.toBe("none");
  expect(chip.textContent).toMatch(/permissions|sandbox|approvals/);
  expect(chip.getAttribute("role")).toBe("status");
});


it("asks explicitly before overriding a real secret-blocked commit", async () => {
  await client.safety(id, { preset: "normal" });
  const secret = "ghp_" + "V".repeat(36);
  fs.writeFileSync(path.join(dir, "credential.txt"), secret);
  execFileSync("git", ["add", "credential.txt"], { cwd: dir });
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  const { w } = mount();
  let confirmations = 0;
  w.confirm = message => { confirmations++; expect(message).not.toContain(secret); return false; };
  await waitUntil(() => !!w.document.querySelector('[data-view="scm"]'));
  (w.document.querySelector('[data-view="scm"]') as HTMLButtonElement).click();
  await waitUntil(() => !!w.document.querySelector("#gcommitbtn") && !(w.document.querySelector("#gcommitbtn") as HTMLButtonElement).disabled);
  (w.document.querySelector("#gmsg") as HTMLTextAreaElement).value = "intentional fixture";
  (w.document.querySelector("#gcommitbtn") as HTMLButtonElement).click();
  await waitUntil(() => confirmations === 1 && !(w.document.querySelector("#gcommitbtn") as HTMLButtonElement).disabled);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe(before);
  w.confirm = () => { confirmations++; return true; };
  (w.document.querySelector("#gmsg") as HTMLTextAreaElement).value = "intentional fixture";
  (w.document.querySelector("#gcommitbtn") as HTMLButtonElement).click();
  await waitUntil(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }) !== before);
  expect(confirmations).toBe(2);
  await waitUntil(async () => (await client.audit(0, true)).entries.some(e => e.what === "secret_override"));
});
