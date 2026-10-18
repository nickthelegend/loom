import { beforeEach, describe, expect, it } from "vitest";
import { AuthManager } from "../src/daemon/auth.js";
import { tmpDir } from "./helpers.js";
import { ensureDaemonConfig, readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";

describe("auth + pairing", () => {
  beforeEach(() => {
    process.env.LOOM_HOME = tmpDir("home");
  });

  function fresh() {
    const cfg = ensureDaemonConfig({ host: "127.0.0.1", port: 0 });
    return { cfg, auth: new AuthManager(cfg) };
  }

  it("authorizes the admin token and rejects garbage", () => {
    const { cfg, auth } = fresh();
    expect(auth.isAuthorized(cfg.adminToken)).toBe(true);
    expect(auth.isAdmin(cfg.adminToken)).toBe(true);
    expect(auth.isAuthorized("nope")).toBe(false);
    expect(auth.isAuthorized(undefined)).toBe(false);
  });

  it("pairing tokens are single-use and mint non-admin client tokens", () => {
    const { auth } = fresh();
    const { token } = auth.newPairingToken();
    const claimed = auth.claim(token, "phone");
    expect(claimed).not.toBeNull();
    expect(auth.isAuthorized(claimed!.clientToken)).toBe(true);
    expect(auth.isAdmin(claimed!.clientToken)).toBe(false);
    // Second claim with the same pairing token must fail.
    expect(auth.claim(token, "attacker")).toBeNull();
  });

  it("clients persist to disk and can be revoked", () => {
    const { cfg, auth } = fresh();
    const { token } = auth.newPairingToken();
    const claimed = auth.claim(token, "phone")!;
    // A fresh AuthManager over the same config file sees the paired client.
    const auth2 = new AuthManager(cfg);
    auth2.reload();
    expect(auth2.isAuthorized(claimed.clientToken)).toBe(true);
    expect(auth2.revoke(claimed.clientId)).toBe(true);
    expect(auth2.isAuthorized(claimed.clientToken)).toBe(false);
  });

  it("rejects unknown pairing tokens", () => {
    const { auth } = fresh();
    expect(auth.claim("deadbeef")).toBeNull();
  });

  it("claim does not clobber fields written after the manager snapshotted", () => {
    const { cfg, auth } = fresh();
    // Daemon writes pid/host/port at listen time, after AuthManager exists.
    const onDisk = { ...cfg, pid: 12345, port: 9999 };
    writeDaemonConfig(onDisk);
    const { token } = auth.newPairingToken();
    expect(auth.claim(token, "phone")).not.toBeNull();
    const after = readDaemonConfig()!;
    expect(after.pid).toBe(12345); // survived the claim
    expect(after.port).toBe(9999);
    expect(after.clients).toHaveLength(1);
  });

  it("Loom Desktop's window is an owner session: as able as the admin token, minted only with it, one at a time", () => {
    const { cfg, auth } = fresh();
    // a phone: a device, not the owner — inviting teammates is "admin only"
    const phone = auth.claim(auth.newPairingToken().token, "phone")!;
    expect(auth.isAdmin(phone.clientToken)).toBe(false);
    // Desktop asks for an owner session
    const desk = auth.claim(auth.newPairingToken(undefined, { owner: true }).token, "Loom Desktop")!;
    expect(auth.isAdmin(desk.clientToken)).toBe(true);
    expect(auth.isRootAdmin(desk.clientToken), "a session isn't the admin token itself").toBe(false);
    expect(auth.isRootAdmin(cfg.adminToken)).toBe(true);
    // every launch pairs again: the new session replaces the last, they don't pile up
    const desk2 = auth.claim(auth.newPairingToken(undefined, { owner: true }).token, "Loom Desktop")!;
    expect(auth.isAdmin(desk2.clientToken)).toBe(true);
    expect(auth.isAuthorized(desk.clientToken)).toBe(false);
    expect(readDaemonConfig()!.clients.filter((c) => c.owner)).toHaveLength(1);
    expect(auth.clients().find((c) => c.id === desk2.clientId)).toMatchObject({ name: "Loom Desktop", owner: true });
    // a project-scoped pairing is never an owner
    const scoped = auth.claim(auth.newPairingToken(["p1"], { owner: true }).token, "x")!;
    expect(auth.isAdmin(scoped.clientToken)).toBe(false);
    // and revoking it takes it away
    auth.revoke(desk2.clientId);
    expect(auth.isAdmin(desk2.clientToken)).toBe(false);
    expect(auth.isAdmin(phone.clientToken)).toBe(false);
  });
});
