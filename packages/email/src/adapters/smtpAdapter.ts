// H12a · Adaptador SMTP genérico (cualquier proveedor: Amazon SES SMTP, SendGrid SMTP,
// Mailgun SMTP, un servidor propio) -- cliente SMTP mínimo escrito a mano sobre
// `node:tls`/`node:net` (sin dependencia nueva como `nodemailer`, mismo criterio que
// packages/db/src/password.ts: este monorepo evita dependencias adicionales cuando el
// protocolo es simple de hablar directamente). Soporta TLS implícito (puerto 465,
// típico de la mayoría de proveedores) y STARTTLS (puerto 587). "Esqueleto honesto":
// sin `SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM`, `configured` es `false` y `send()`
// devuelve `no_configurado` sin abrir ningún socket.
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Socket } from "node:net";
import type { EmailMessage, EmailPort, EmailSendResult } from "../port.ts";

export interface SmtpAdapterConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  /** true = TLS implícito desde la conexión (puerto 465 típico). false = STARTTLS
   *  sobre texto plano (puerto 587 típico). Por defecto se infiere del puerto. */
  implicitTls?: boolean;
  timeoutMs?: number;
}

function readLine(socket: Socket | TLSSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`smtp_timeout: sin respuesta del servidor en ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf8"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.once("data", onData);
    socket.once("error", onError);
  });
}

function write(socket: Socket | TLSSocket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/** Envía un comando y valida que la respuesta empiece con uno de los códigos
 *  esperados (p. ej. "250", "354") -- cualquier otro código se trata como fallo
 *  explícito, nunca se ignora. */
async function command(socket: Socket | TLSSocket, line: string, expected: string[], timeoutMs: number): Promise<string> {
  await write(socket, line);
  const reply = await readLine(socket, timeoutMs);
  const code = reply.slice(0, 3);
  if (!expected.includes(code)) {
    throw new Error(`smtp_respuesta_inesperada: se esperaba ${expected.join("/")} y llegó "${reply.trim()}"`);
  }
  return reply;
}

function encodeMimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): string {
  const boundary = `atiende-hoteles-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodedSubject}`,
    opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter((l): l is string => l !== null);

  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.text, "utf8").toString("base64"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.html, "utf8").toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export class SmtpAdapter implements EmailPort {
  readonly provider = "smtp";
  private config: Required<Pick<SmtpAdapterConfig, "host" | "port" | "user" | "pass" | "from">> | null;
  private implicitTls: boolean;
  private timeoutMs: number;

  constructor(config: SmtpAdapterConfig = {}) {
    const host = config.host ?? process.env.SMTP_HOST;
    const port = config.port ?? Number(process.env.SMTP_PORT ?? 587);
    const user = config.user ?? process.env.SMTP_USER;
    const pass = config.pass ?? process.env.SMTP_PASS;
    const from = config.from ?? process.env.SMTP_FROM;

    this.config = host && user && pass && from ? { host, port, user, pass, from } : null;
    this.implicitTls = config.implicitTls ?? port === 465;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return this.config !== null;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.config) {
      return {
        status: "no_configurado",
        provider: this.provider,
        simulated: false,
        error: "SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM no configurados: SMTP está pendiente de configurar en este entorno.",
      };
    }

    const { host, port, user, pass, from } = this.config;
    const to = message.to.email;

    let socket: Socket | TLSSocket | null = null;
    try {
      socket = this.implicitTls
        ? tlsConnect({ host, port, servername: host })
        : new Socket();

      await new Promise<void>((resolve, reject) => {
        const s = socket!;
        s.once("error", reject);
        if (this.implicitTls) {
          s.once("secureConnect", () => resolve());
        } else {
          (s as Socket).connect(port, host, () => resolve());
        }
      });

      await readLine(socket, this.timeoutMs); // banner 220

      await command(socket, `EHLO atiende-hoteles.local`, ["250"], this.timeoutMs);

      if (!this.implicitTls) {
        await command(socket, "STARTTLS", ["220"], this.timeoutMs);
        const plainSocket = socket as Socket;
        socket = tlsConnect({ socket: plainSocket, servername: host });
        await new Promise<void>((resolve, reject) => {
          socket!.once("secureConnect", () => resolve());
          socket!.once("error", reject);
        });
        await command(socket, `EHLO atiende-hoteles.local`, ["250"], this.timeoutMs);
      }

      await command(socket, "AUTH LOGIN", ["334"], this.timeoutMs);
      await command(socket, Buffer.from(user, "utf8").toString("base64"), ["334"], this.timeoutMs);
      await command(socket, Buffer.from(pass, "utf8").toString("base64"), ["235"], this.timeoutMs);

      await command(socket, `MAIL FROM:<${from}>`, ["250"], this.timeoutMs);
      await command(socket, `RCPT TO:<${to}>`, ["250", "251"], this.timeoutMs);
      await command(socket, "DATA", ["354"], this.timeoutMs);

      const mime = encodeMimeMessage({ from, to, subject: message.subject, html: message.html, text: message.text, replyTo: message.replyTo });
      await write(socket, `${mime}\r\n.`);
      const finalReply = await readLine(socket, this.timeoutMs);
      if (!finalReply.startsWith("250")) {
        throw new Error(`smtp_respuesta_inesperada tras DATA: "${finalReply.trim()}"`);
      }

      await write(socket, "QUIT").catch(() => undefined);

      return { status: "enviado", provider: this.provider, simulated: false };
    } catch (err) {
      return { status: "fallido", provider: this.provider, simulated: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      socket?.end();
      socket?.destroy();
    }
  }
}
