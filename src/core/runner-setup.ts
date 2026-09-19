/**
 * Setting up a runner box (Loom Teams, Phase 5; D77, D78): the service that
 * keeps `loom daemon` running, and the checks `loom runner doctor` makes.
 * Pure — the CLI writes the files and runs the commands.
 */

export interface ServiceFile {
  path: string;
  content: string;
  /** Commands that enable and start it. */
  enable: string[][];
}

/** A user-level service running the Loom daemon in runner mode. */
export function serviceFile(opts: { platform: NodeJS.Platform; home: string; node: string; loom: string; loomHome?: string }): ServiceFile {
  const env = opts.loomHome ? { LOOM_HOME: opts.loomHome } : {};
  if (opts.platform === "darwin") {
    const label = "dev.loom.runner";
    const envXml = Object.entries(env)
      .map(([k, v]) => `      <key>${k}</key><string>${v}</string>`)
      .join("\n");
    return {
      path: `${opts.home}/Library/LaunchAgents/${label}.plist`,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${label}</string>`,
        "  <key>ProgramArguments</key>",
        `  <array><string>${opts.node}</string><string>${opts.loom}</string><string>daemon</string></array>`,
        "  <key>RunAtLoad</key><true/>",
        "  <key>KeepAlive</key><true/>",
        `  <key>StandardOutPath</key><string>${opts.home}/.loom/runner.log</string>`,
        `  <key>StandardErrorPath</key><string>${opts.home}/.loom/runner.log</string>`,
        ...(envXml ? ["  <key>EnvironmentVariables</key>", "  <dict>", envXml, "  </dict>"] : []),
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
      enable: [["launchctl", "load", "-w", `${opts.home}/Library/LaunchAgents/${label}.plist`]],
    };
  }
  return {
    path: `${opts.home}/.config/systemd/user/loom-runner.service`,
    content: [
      "[Unit]",
      "Description=Loom runner (takes your team's goals while you're away)",
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${opts.node} ${opts.loom} daemon`,
      ...Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`),
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
    enable: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "loom-runner.service"],
    ],
  };
}

export interface DoctorItem {
  level: "ok" | "warn" | "error";
  what: string;
  fix?: string;
}

/**
 * D77: what the runner's GitHub token can do. `scopes` is the X-OAuth-Scopes
 * header (classic tokens only; empty for fine-grained ones); `repos` is each
 * shared repo's `permissions` object from `gh api repos/<r>`, or null when the
 * token can't see it.
 */
export function tokenFindings(opts: { present: boolean; scopes: string[]; repos: Record<string, Record<string, boolean> | null> }): DoctorItem[] {
  const out: DoctorItem[] = [];
  if (!opts.present) {
    return [{ level: "warn", what: "no runner token — pushes use whatever `gh auth` has on this box", fix: "loom runner token <fine-grained PAT> (contents + pull requests, read/write, on the shared repos only)" }];
  }
  if (opts.scopes.length) {
    const broad = opts.scopes.filter((s) => /^(repo|admin:.*|delete_repo|workflow|write:packages|admin_org|user)$/.test(s));
    out.push({
      level: broad.length ? "warn" : "ok",
      what: `a classic token with scopes: ${opts.scopes.join(", ")}`,
      ...(broad.length ? { fix: `use a fine-grained token instead — ${broad.join(", ")} reaches every repo you can` } : {}),
    });
  } else out.push({ level: "ok", what: "a fine-grained token" });
  for (const [repo, perm] of Object.entries(opts.repos)) {
    if (!perm) out.push({ level: "error", what: `the token can't see ${repo}`, fix: `grant it access to ${repo} (contents + pull requests)` });
    else if (perm.admin) out.push({ level: "warn", what: `the token is an admin of ${repo}`, fix: "a runner only needs contents and pull requests — drop admin" });
    else if (!perm.push) out.push({ level: "error", what: `the token can't push to ${repo}`, fix: "give it contents: read and write" });
    else out.push({ level: "ok", what: `can push to ${repo}, without admin` });
  }
  return out;
}
