export interface LockState { ready: boolean; enabled: boolean; locked: boolean; error: string }
export class PhoneLock {
  state: LockState = { ready: false, enabled: false, locked: true, error: "" };
  private prompting = false;
  private epoch = 0;
  private foreground = true;
  private load: () => Promise<boolean>;
  private save: (on: boolean) => Promise<void>;
  private available: () => Promise<boolean>;
  private authenticate: () => Promise<boolean>;
  private changed: (state: LockState) => void;
  constructor(load: () => Promise<boolean>, save: (on: boolean) => Promise<void>, available: () => Promise<boolean>, authenticate: () => Promise<boolean>, changed: (state: LockState) => void) {
    this.load = load; this.save = save; this.available = available; this.authenticate = authenticate; this.changed = changed;
  }
  private publish(update: Partial<LockState>) { this.state = { ...this.state, ...update }; this.changed(this.state); }
  async start() {
    try { const enabled = await this.load(); this.publish({ ready: true, enabled, locked: enabled }); if (enabled) await this.unlock(); }
    catch { this.publish({ error: "Could not read lock settings. Reopen Loom to try again." }); }
  }
  private async verify(): Promise<boolean> {
    if (this.prompting) return false;
    this.prompting = true;
    const epoch = this.epoch;
    try { return await this.authenticate() && epoch === this.epoch && this.foreground; }
    catch { return false; }
    finally { this.prompting = false; }
  }
  async unlock() {
    if (!this.state.ready) return this.start();
    if (await this.verify()) this.publish({ locked: false, error: "" });
    else this.publish({ error: "Loom is locked. Check device biometrics, then try again." });
  }
  async toggle(on: boolean) {
    if (on && !await this.available()) throw new Error("Set up Face ID or a fingerprint on this device first.");
    if (!await this.verify()) return;
    await this.save(on); this.publish({ enabled: on, locked: on && !this.foreground, error: "" });
  }
  activity(state: string) {
    if (state === "active") {
      const returned = !this.foreground; this.foreground = true;
      if (returned && this.state.enabled && !this.prompting) void this.unlock();
    } else if (state === "background" || !this.prompting) {
      this.foreground = false; this.epoch++;
      if (this.state.enabled) this.publish({ locked: true });
    }
  }
}

export class Feedback {
  enabled = false;
  private load: () => Promise<boolean>;
  private save: (on: boolean) => Promise<void>;
  constructor(load: () => Promise<boolean>, save: (on: boolean) => Promise<void>) { this.load = load; this.save = save; }
  async hydrate() { this.enabled = await this.load(); return this.enabled; }
  async choose(on: boolean) { await this.save(on); this.enabled = on; }
  run(effect: () => void) { if (this.enabled) effect(); }
}
