// H12a · packages/email: puerto de envío de correo (mismo patrón puerto/adaptador que
// `PaymentProviderPort`/`CfdiPort` de apps/api, ADR-007). `render()` vive en cada
// plantilla (src/templates/*.ts), no en el puerto -- el puerto SOLO sabe entregar un
// mensaje ya renderizado, nunca conoce el contenido de negocio de ninguna plantilla.
//
// Contrato de "honestidad" (mismo principio que `FakeStripeAdapter`/`FakeFinkokAdapter`
// de apps/api): sin credenciales reales, un adaptador real (`ResendAdapter`/
// `SmtpAdapter`) NUNCA finge un envío exitoso -- devuelve `status: "no_configurado"`
// explícito. Solo `FakeEmailAdapter` (uso exclusivo de dev/test/preview) devuelve
// `status: "enviado"` con `simulated: true`.

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
}

/** Salida de `render()` de una plantilla: HTML + texto plano + metadatos de envío. */
export interface RenderedEmail {
  subject: string;
  /** Preheader (texto de vista previa oculto, ver src/layout.ts) -- nunca vacío: un
   *  preheader vacío deja que Gmail/Outlook usen el primer texto visible del cuerpo
   *  (normalmente el wordmark), que es una vista previa fea/inútil. */
  preheader: string;
  html: string;
  text: string;
}

export interface EmailMessage extends RenderedEmail {
  to: EmailAddress;
  from?: EmailAddress;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Nombre de la plantilla que generó este mensaje (p. ej. "verificacion-cuenta") --
   *  se persiste en `email_outbox.template` para auditoría/preview, nunca se infiere
   *  del asunto (que puede cambiar de redacción sin cambiar de plantilla). */
  template: string;
  /** Clave de deduplicación opcional (ver migración 0094) -- un handler de
   *  `public.outbox` reintentado con la misma clave no debe producir un segundo correo. */
  dedupeKey?: string;
  tenantId?: string | null;
  hotelId?: string | null;
}

export type EmailSendStatus = "enviado" | "no_configurado" | "fallido";

export interface EmailSendResult {
  status: EmailSendStatus;
  provider: string;
  providerMessageId?: string;
  /** true cuando el "envío" fue simulado (FakeEmailAdapter) -- nunca true para un
   *  adaptador real, ni siquiera en status "no_configurado". */
  simulated: boolean;
  error?: string;
}

export interface EmailPort {
  readonly provider: string;
  /** true si hay credenciales suficientes para intentar un envío real. */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
