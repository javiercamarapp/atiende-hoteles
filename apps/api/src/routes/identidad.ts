// REQ-REC-011/REQ-SEG-014/REQ-SEG-004/REQ-REC-010 · Bóveda de identidad: registrar el
// documento de un huésped a partir de su MRZ (validada por dígitos de control,
// packages/domain-hotel/src/mrz.ts), cifrar el número en código de aplicación
// (apps/api/src/lib/identityEncryption.ts) y guardarlo en la bóveda aislada
// (packages/db/migrations/0051_identity_vault.sql) -- el resto del sistema solo ve
// `identity_ref` (nombre/nacionalidad/tipo/últimos 4). La imagen del documento, si se
// envía, NUNCA se persiste ni se reenvía a ningún LLM: se recibe, se ignora, se
// descarta al terminar de procesar esta request (no existe ninguna columna ni tabla en
// todo el esquema que pueda almacenarla -- ver cabecera de la migración 0051).
import { Hono } from "hono";
import { z } from "zod";
import { parsePassportMrz, InvalidMrzError } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES, type HotelRole } from "../domain/roles.ts";
import { decryptIdentityField, encryptIdentityField, loadIdentityVaultEncryptionKey } from "../lib/identityEncryption.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const registrarSchema = z.object({
  mrzLine1: z.string().trim().length(44),
  mrzLine2: z.string().trim().length(44),
  /** Recibida y DESCARTADA -- ver cabecera de este archivo. Nunca se lee más allá de
   *  esta validación de esquema (ni se guarda en ninguna variable posterior, ni se
   *  loguea: `logger`/`pino` de este repo nunca recibe el body completo de esta
   *  request, solo campos explícitos). */
  documentImageBase64: z.string().optional(),
  retencionDias: z.number().int().min(1).max(365).optional(),
  // auditoria-2/legal [ALTO]: obligatorio cuando `retencionDias` supera el default
  // legal (30 dias, REQ-SEG-004) -- validado tambien en la base
  // (register_identity_document, migracion 0067) como defensa en profundidad.
  motivoRetencionExtendida: z.string().trim().min(3).max(500).optional(),
});

const revelarSchema = z.object({
  motivo: z.string().trim().min(3).max(500),
});

interface IdentityRefRow {
  id: string;
  full_name: string;
  nationality: string;
  document_type: string;
  document_last4: string;
}

function toIdentityRefBody(row: IdentityRefRow) {
  return {
    id: row.id,
    nombreCompleto: row.full_name,
    nacionalidad: row.nationality,
    tipoDocumento: row.document_type,
    ultimos4: row.document_last4,
  };
}

export function identidadRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/identidad*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/identidad/:identityRefId/revelar",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/reservas/:reservationId/identidad", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");
    // El body se parsea completo por Zod (incluida `documentImageBase64`, para que un
    // campo mal formado falle con 400 en vez de colarse), pero de aquí en adelante
    // NUNCA se vuelve a leer `body.documentImageBase64` -- se descarta al salir de este
    // scope, nunca se persiste (REQ-REC-011).
    const body = parseBody(registrarSchema, await c.req.json().catch(() => ({})));

    let parsed;
    try {
      parsed = parsePassportMrz(body.mrzLine1, body.mrzLine2);
    } catch (err) {
      if (err instanceof InvalidMrzError) {
        throw Errors.validation(`MRZ inválida: ${err.message}`);
      }
      throw err;
    }

    const retencionDias = body.retencionDias ?? 30;
    if (retencionDias > 30) {
      // Extender mas alla del default legal exige rol owner/gm (nunca frontdesk/
      // reservations, aunque ese sea el minimo para registrar identidad) Y un motivo
      // explicito -- ambos re-validados en la base (register_identity_document).
      assertRole(c, ADMIN_ROLES as HotelRole[]);
      if (!body.motivoRetencionExtendida) {
        throw Errors.validation("Una retención mayor a 30 días requiere justificar el motivo (motivoRetencionExtendida).");
      }
    }

    const key = loadIdentityVaultEncryptionKey();
    const encrypted = encryptIdentityField(parsed.documentNumber, key);
    const last4 = parsed.documentNumber.slice(-4).padStart(4, "0");

    const { rows } = await db.query<IdentityRefRow>(
      `select id, full_name, nationality, document_type, document_last4
       from public.register_identity_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
      [
        orgId,
        hotelId,
        reservationId,
        parsed.fullName,
        parsed.nationality,
        parsed.documentType,
        last4,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        retencionDias,
        body.motivoRetencionExtendida ?? null,
      ],
    );

    return c.json(toIdentityRefBody(rows[0]!), 201);
  });

  app.get("/hoteles/:hotelId/reservas/:reservationId/identidad", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");

    const { rows } = await db.query<IdentityRefRow>(
      `select id, full_name, nationality, document_type, document_last4
       from public.identity_ref where hotel_id = $1 and reservation_id = $2
       order by created_at desc limit 1;`,
      [hotelId, reservationId],
    );
    if (rows.length === 0) throw Errors.notFound("Esta reserva no tiene un documento de identidad registrado todavía.");

    return c.json(toIdentityRefBody(rows[0]!));
  });

  // REQ-SEG-014: acceso auditado por rol al número de documento completo (solo
  // owner/gm, cada lectura queda en audit_log vía read_identity_vault_document).
  app.post("/hoteles/:hotelId/identidad/:identityRefId/revelar", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const identityRefId = c.req.param("identityRefId");
    const body = parseBody(revelarSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await db.query<{ document_number_ciphertext: Buffer; document_number_iv: Buffer; document_number_auth_tag: Buffer }>(
        "select * from public.read_identity_vault_document($1, $2);",
        [identityRefId, body.motivo],
      );
      const row = rows[0]!;
      const key = loadIdentityVaultEncryptionKey();
      const documentNumber = decryptIdentityField(
        { ciphertext: row.document_number_ciphertext, iv: row.document_number_iv, authTag: row.document_number_auth_tag },
        key,
      );
      return c.json({ numeroDocumento: documentNumber });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/acceso_boveda_no_autorizado/.test(message)) throw Errors.forbidden("Solo owner/gm pueden revelar el documento completo de la bóveda de identidad.");
      if (/identity_ref_no_encontrado/.test(message)) throw Errors.notFound("Documento de identidad no encontrado.");
      throw err;
    }
  });

  return app;
}
