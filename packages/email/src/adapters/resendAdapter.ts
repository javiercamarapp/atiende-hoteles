// H12a · Adaptador real de Resend (https://resend.com/docs/api-reference/emails/send-email)
// -- "esqueleto honesto" (mismo principio que FakeStripeAdapter/FakeFinkokAdapter de
// apps/api): usa `fetch` nativo (Node 22), sin SDK adicional. Sin `RESEND_API_KEY`
// configurada, `configured` es `false` y `send()` devuelve `status: "no_configurado"`
// SIN intentar ninguna llamada de red -- nunca finge un envío exitoso. Variables
// exactas documentadas en packages/email/README.md.
import type { EmailMessage, EmailPort, EmailSendResult } from "../port.ts";

export interface ResendAdapterConfig {
  apiKey?: string;
  /** Remitente por defecto si el mensaje no trae `from` -- debe ser un dominio
   *  verificado en el panel de Resend (DKIM/SPF), ver README. */
  defaultFrom?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendAdapter implements EmailPort {
  readonly provider = "resend";
  private apiKey: string | undefined;
  private defaultFrom: string | undefined;

  constructor(config: ResendAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.RESEND_API_KEY;
    this.defaultFrom = config.defaultFrom ?? process.env.RESEND_FROM_EMAIL;
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.defaultFrom);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.configured) {
      return {
        status: "no_configurado",
        provider: this.provider,
        simulated: false,
        error: "RESEND_API_KEY/RESEND_FROM_EMAIL no configurados: Resend está pendiente de configurar en este entorno.",
      };
    }

    const from = message.from ? `${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}` : this.defaultFrom!;
    const to = message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email;

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          reply_to: message.replyTo,
          attachments: message.attachments?.map((a) => ({
            filename: a.filename,
            content: a.contentBase64,
          })),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { status: "fallido", provider: this.provider, simulated: false, error: `Resend respondió ${res.status}: ${body.slice(0, 300)}` };
      }

      const json = (await res.json()) as { id?: string };
      return { status: "enviado", provider: this.provider, providerMessageId: json.id, simulated: false };
    } catch (err) {
      return { status: "fallido", provider: this.provider, simulated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
