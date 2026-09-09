// REQ-REC-011/REQ-SEG-014/REQ-SEG-004/REQ-REC-010 · Bóveda de identidad: registrar el
// documento de un huésped a partir de su MRZ (validada por dígitos de control,
// packages/domain-hotel/src/mrz.ts), cifrar el número en código de aplicación
// (apps/api/src/lib/identityEncryption.ts) y guardarlo en la bóveda aislada
// (packages/db/migrations/0051_identity_vault.sql) -- el resto del sistema solo ve
// `identity_ref` (nombre/nacionalidad/tipo/últimos 4). La imagen del documento, si se
// envía, NUNCA se persiste ni se reenvía a ningún LLM: se recibe, se ignora, se
// descarta al terminar de procesar esta request (no existe ninguna columna ni tabla en
// todo el esquema que pueda almacenarla -- ver cabecera de la migración 0051).
//
// REQ-SEG-014 (doble control pleno, packages/db/migrations/0085_identity_vault_doble_control.sql):
// revelar el número completo ya NO es un solo paso -- un owner/gm SOLICITA acceso
// (`/revelar/solicitudes`), un owner/gm DISTINTO lo APRUEBA o RECHAZA
// (`/solicitudes/:requestId/decision`), y solo entonces quien solicitó puede
// EXPONERLO (`/solicitudes/:requestId/revelar`), una sola vez.
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

const solicitarRevelarSchema = z.object({
  motivo: z.string().trim().min(3).max(500),
});

const decisionSchema = z.object({
  decision: z.enum(["aprobar", "rechazar"]),
});

interface AccessRequestRow {
  id: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  expires_at: string;
}

function toAccessRequestBody(row: AccessRequestRow) {
  return {
    id: row.id,
    estado: row.status,
    solicitadoPor: row.requested_by,
    aprobadoPor: row.approved_by,
    expiraEn: row.expires_at,
  };
}

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
  // Wildcard: cubre tanto "/identidad/:identityRefId/revelar/solicitudes" (paso 1)
  // como "/identidad/solicitudes/:requestId/decision|revelar" (pasos 2/3) -- todas
  // exigen la misma membresía de hotel, el rol exacto se valida por handler.
  app.use(
    "/hoteles/:hotelId/identidad/*",
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

  // REQ-SEG-014 paso 1/3: un owner/gm SOLICITA acceso al documento completo de un
  // `identity_ref`, documentando el motivo. No revela nada todavía -- solo crea la
  // solicitud (`identity_vault_access_request`, 0082) en estado `pendiente`.
  app.post("/hoteles/:hotelId/identidad/:identityRefId/revelar/solicitudes", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const identityRefId = c.req.param("identityRefId");
    const body = parseBody(solicitarRevelarSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await db.query<AccessRequestRow>(
        "select * from public.request_identity_vault_access($1, $2);",
        [identityRefId, body.motivo],
      );
      return c.json(toAccessRequestBody(rows[0]!), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/rol_no_autorizado/.test(message)) throw Errors.forbidden("Solo owner/gm pueden solicitar revelar el documento completo de la bóveda de identidad.");
      if (/identity_ref_no_encontrado/.test(message)) throw Errors.notFound("Documento de identidad no encontrado.");
      throw err;
    }
  });

  // REQ-SEG-014 paso 2/3: un owner/gm DISTINTO de quien solicitó aprueba o rechaza --
  // este es el doble control en sí. Auto-aprobación explícitamente rechazada.
  app.post("/hoteles/:hotelId/identidad/solicitudes/:requestId/decision", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const requestId = c.req.param("requestId");
    const body = parseBody(decisionSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await db.query<AccessRequestRow>(
        "select * from public.decide_identity_vault_access($1, $2);",
        [requestId, body.decision],
      );
      return c.json(toAccessRequestBody(rows[0]!));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/autoaprobacion_no_permitida/.test(message)) throw Errors.forbidden("Quien solicita el acceso no puede aprobar su propia solicitud (doble control, REQ-SEG-014).");
      if (/rol_no_autorizado/.test(message)) throw Errors.forbidden("Solo owner/gm pueden decidir sobre una solicitud de la bóveda de identidad.");
      if (/solicitud_no_encontrada/.test(message)) throw Errors.notFound("Solicitud de acceso a la bóveda de identidad no encontrada.");
      if (/solicitud_no_pendiente/.test(message)) throw Errors.conflict("Esta solicitud ya fue decidida o expiró.");
      if (/solicitud_expirada/.test(message)) throw Errors.conflict("Esta solicitud ya expiró; hay que solicitar el acceso de nuevo.");
      throw err;
    }
  });

  // REQ-SEG-014 paso 3/3: SOLO quien solicitó el acceso puede exponer el documento de
  // una solicitud ya `aprobada`, y solo una vez (de un solo uso). Cada lectura queda
  // auditada en `audit_log` vía `reveal_identity_vault_document`.
  app.post("/hoteles/:hotelId/identidad/solicitudes/:requestId/revelar", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const requestId = c.req.param("requestId");

    try {
      const { rows } = await db.query<{ document_number_ciphertext: Buffer; document_number_iv: Buffer; document_number_auth_tag: Buffer }>(
        "select * from public.reveal_identity_vault_document($1);",
        [requestId],
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
      if (/actor_no_autorizado/.test(message)) throw Errors.forbidden("Solo quien solicitó el acceso puede exponer este documento.");
      if (/rol_no_autorizado/.test(message)) throw Errors.forbidden("Solo owner/gm pueden revelar el documento completo de la bóveda de identidad.");
      if (/solicitud_no_encontrada/.test(message)) throw Errors.notFound("Solicitud de acceso a la bóveda de identidad no encontrada.");
      if (/solicitud_ya_consumida/.test(message)) throw Errors.conflict("Esta solicitud ya se usó para exponer el documento; hay que solicitar el acceso de nuevo.");
      if (/solicitud_no_aprobada/.test(message)) throw Errors.conflict("Esta solicitud todavía no fue aprobada por una segunda persona (doble control, REQ-SEG-014).");
      if (/solicitud_expirada/.test(message)) throw Errors.conflict("Esta solicitud ya expiró; hay que solicitar el acceso de nuevo.");
      throw err;
    }
  });

  return app;
}
