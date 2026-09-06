// H12a · Adaptador FALSO -- uso exclusivo de dev/test/`npm run email:preview` (nunca en
// producción, ver README). Guarda cada mensaje en un "sink" en vez de llamar a un
// proveedor real: `dbEmailOutboxSink` (tabla `email_outbox`, migración 0094 -- lo que
// usan las pruebas de integración/E2E para leer "el correo que se habría enviado") o
// `fileEmailOutboxSink` (un directorio local de archivos `.json`, lo que usa
// `npm run email:preview` sin necesitar una base de datos levantada).
//
// Deduplicación: si `message.dedupeKey` ya existe en el sink, `send()` devuelve el
// resultado existente SIN insertar una segunda fila -- mismo principio que
// `idempotency_key` (ADR-004): un handler de `public.outbox` reintentado no debe
// producir un correo duplicado.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailMessage, EmailPort, EmailSendResult } from "../port.ts";

export interface EmailOutboxEntry {
  id: string;
  tenantId: string | null;
  hotelId: string | null;
  template: string;
  toEmail: string;
  toName: string | null;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  dedupeKey: string | null;
  status: "enviado";
  provider: "fake";
  createdAt: string;
}

export interface EmailOutboxSink {
  /** Busca una entrada ya guardada con esta `dedupeKey` (o `null` si no aplica/no existe). */
  findByDedupeKey(dedupeKey: string): Promise<EmailOutboxEntry | null>;
  save(entry: EmailOutboxEntry): Promise<void>;
}

/** Cliente mínimo compatible con `DbClient` de `@atiende-hoteles/db` -- se declara
 *  estructuralmente aquí (sin depender de ese paquete) para que `packages/email` no
 *  tenga ninguna dependencia hacia `apps/api`/`packages/db` (ADR-007, puerto/adaptador
 *  desacoplado). */
export interface QueryableDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export function dbEmailOutboxSink(db: QueryableDb): EmailOutboxSink {
  return {
    async findByDedupeKey(dedupeKey) {
      const { rows } = await db.query<{
        id: string;
        tenant_id: string | null;
        hotel_id: string | null;
        template: string;
        to_email: string;
        to_name: string | null;
        subject: string;
        preheader: string;
        html: string;
        text_body: string;
        dedupe_key: string | null;
        created_at: string;
      }>("select * from public.email_outbox where dedupe_key = $1 limit 1;", [dedupeKey]);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        hotelId: row.hotel_id,
        template: row.template,
        toEmail: row.to_email,
        toName: row.to_name,
        subject: row.subject,
        preheader: row.preheader,
        html: row.html,
        text: row.text_body,
        dedupeKey: row.dedupe_key,
        status: "enviado",
        provider: "fake",
        createdAt: row.created_at,
      };
    },
    async save(entry) {
      await db.query(
        `insert into public.email_outbox
           (id, tenant_id, hotel_id, template, to_email, to_name, subject, preheader, html, text_body, dedupe_key, status, provider, sent_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'enviado', 'fake', now())
         on conflict (dedupe_key) where dedupe_key is not null do nothing;`,
        [
          entry.id,
          entry.tenantId,
          entry.hotelId,
          entry.template,
          entry.toEmail,
          entry.toName,
          entry.subject,
          entry.preheader,
          entry.html,
          entry.text,
          entry.dedupeKey,
        ],
      );
    },
  };
}

export function fileEmailOutboxSink(dir: string): EmailOutboxSink {
  return {
    async findByDedupeKey(dedupeKey) {
      try {
        const files = await readdir(dir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const raw = await readFile(join(dir, file), "utf8");
          const entry = JSON.parse(raw) as EmailOutboxEntry;
          if (entry.dedupeKey === dedupeKey) return entry;
        }
        return null;
      } catch {
        return null;
      }
    },
    async save(entry) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf8");
    },
  };
}

export class FakeEmailAdapter implements EmailPort {
  readonly provider = "fake";
  readonly configured = true;
  private sink: EmailOutboxSink;

  constructor(sink: EmailOutboxSink) {
    this.sink = sink;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (message.dedupeKey) {
      const existing = await this.sink.findByDedupeKey(message.dedupeKey);
      if (existing) {
        return { status: "enviado", provider: this.provider, providerMessageId: existing.id, simulated: true };
      }
    }

    const id = crypto.randomUUID();
    await this.sink.save({
      id,
      tenantId: message.tenantId ?? null,
      hotelId: message.hotelId ?? null,
      template: message.template,
      toEmail: message.to.email,
      toName: message.to.name ?? null,
      subject: message.subject,
      preheader: message.preheader,
      html: message.html,
      text: message.text,
      dedupeKey: message.dedupeKey ?? null,
      status: "enviado",
      provider: "fake",
      createdAt: new Date().toISOString(),
    });

    return { status: "enviado", provider: this.provider, providerMessageId: id, simulated: true };
  }
}
