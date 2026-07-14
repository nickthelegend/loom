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
});
