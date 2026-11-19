import net from "node:net";
import tls from "node:tls";

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: string;
  from: string;
  to: string;
  everyHours: number;
  lastSentAt?: number;
}

/** SMTP replies can span packets and lines; only the final code-space line completes a reply. */
export async function sendMail(settings: SmtpSettings, subject: string, text: string, trust: { ca?: string } = {}): Promise<void> {
  let socket: net.Socket = settings.security === "tls"
    ? tls.connect({ ...trust, checkServerIdentity: (_host, cert) => tls.checkServerIdentity(settings.host, cert), host: settings.host, port: settings.port, servername: net.isIP(settings.host) ? undefined : settings.host })
    : net.connect({ host: settings.host, port: settings.port });
  let buffer = "", lines: string[] = [];
  const replies: Array<{ code: number; text: string }> = [];
  let waiter: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = (e: Error) => { failure = e; waiter?.reject(e); waiter = undefined; };
  const data = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 64_000) { socket.destroy(); fail(new Error("SMTP response too large")); return; }
    let end: number;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); lines.push(line);
      if (lines.length > 1000 || replies.length > 100) { socket.destroy(new Error("SMTP response too large")); return; }
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join("\n") }; lines = [];
        if (waiter) { const w = waiter; waiter = undefined; w.resolve(reply); } else replies.push(reply);
      }
    }
  };
  const attach = () => {
    socket.on("data", data); socket.on("error", fail);
    socket.on("end", () => fail(new Error("SMTP connection closed")));
    socket.setTimeout(15_000, () => socket.destroy(new Error("SMTP timed out")));
  };
  attach();
  const deadline = setTimeout(() => socket.destroy(new Error("SMTP delivery timed out")), 60_000);
  deadline.unref();
  const reply = async (code: number) => {
    if (failure) throw failure;
    const r = replies.shift() ?? await new Promise<{ code: number; text: string }>((resolve, reject) => { waiter = { resolve, reject }; });
    if (r.code !== code) throw new Error(`SMTP expected ${code}, received ${r.code}`);
    return r.text;
  };
  const command = (line: string, code: number) => { socket.write(line + "\r\n"); return reply(code); };
  try {
    await reply(220);
    const hello = await command("EHLO loom.local", 250);
    if (settings.security === "starttls") {
      if (!/STARTTLS/i.test(hello)) throw new Error("SMTP server does not support STARTTLS");
      await command("STARTTLS", 220);
      socket.removeListener("data", data); socket.removeListener("error", fail); socket.removeAllListeners("end"); socket.setTimeout(0);
      socket = tls.connect({ ...trust, checkServerIdentity: (_host, cert) => tls.checkServerIdentity(settings.host, cert), socket, servername: net.isIP(settings.host) ? undefined : settings.host });
      attach();
      await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
      await command("EHLO loom.local", 250);
    }
    if (settings.username) await command(`AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${settings.password}`).toString("base64")}`, 235);
    await command(`MAIL FROM:<${settings.from}>`, 250);
    await command(`RCPT TO:<${settings.to}>`, 250);
    await command("DATA", 354);
    const body = Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    await command(`From: ${settings.from}\r\nTo: ${settings.to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n.`, 250);
    // Delivery succeeded at DATA's 250; a failed QUIT must not cause duplicate mail.
    socket.write("QUIT\r\n");
  } finally { clearTimeout(deadline); socket.destroy(); }
}
