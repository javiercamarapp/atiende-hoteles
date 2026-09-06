// REQ-RES-016 · check-in online de UN SOLO USO (formulario web -- el WhatsApp Flow
// cifrado queda documentado como bloqueado por credencial real de Meta, ver
// docs/cierre-p0/inventario.md §2). El "pago/garantía" tampoco se simula aquí (requiere
// pasarela real, misma dependencia ya declarada para REQ-RES-003/008) -- esta ruta
// captura lo que SÍ es real sin ninguna credencial: datos del huésped, identidad
// (MRZ validada + bóveda cifrada, reutilizando REQ-REC-011 sin duplicar su lógica),
// firma de registro, ETA y RFC.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { parsePassportMrz, InvalidMrzError } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import { encryptIdentityField, loadIdentityVaultEncryptionKey } from "../lib/identityEncryption.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const CHECKIN_LINK_TTL_HOURS = 72;
const RFC_PATTERN = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/i;

// auditoria-2/legal [ALTO] "El check-in online captura el documento de identidad del
// huésped sin registrar ningún consentimiento". Versión del aviso de privacidad vigente
// al momento de este check-in -- se registra tal cual en `consent.aviso_version`
// (packages/db/migrations/0068) para poder demostrar CUÁL versión del aviso aceptó cada
// huésped si el texto cambia después. pendiente-decision: el fundador/equipo legal debe
// confirmar el versionado real del aviso publicado en apps/web (hoy es un string fijo,
// ver apps/web/src/pages/Privacidad.tsx).
export const PRIVACY_NOTICE_VERSION = "2026-09-pendiente-confirmacion-legal";

const completarSchema = z.object({
  nombreCompleto: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().optional(),
  telefono: z.string().trim().min(8).max(20).optional(),
  etaEstimada: z.string().datetime().optional(),
  rfc: z.string().trim().regex(RFC_PATTERN, "RFC con formato inválido").optional(),
  firmaDataUrl: z.string().trim().min(1).max(200_000),
  mrzLine1: z.string().trim().length(44),
  mrzLine2: z.string().trim().length(44),
  /** Recibida y DESCARTADA -- ver el mismo criterio que routes/identidad.ts: nunca se
   *  persiste, no existe columna alguna que pueda almacenarla. */
  documentImageBase64: z.string().optional(),
  // auditoria-2/legal [ALTO]: aceptación EXPRESA y verificable del aviso de privacidad
  // antes de capturar el documento de identidad -- sin esto, LFPDPPP exige consentimiento
  // expreso para el dato más sensible que el sistema procesa y hoy no había ni checkbox
  // ni registro. `z.literal(true)` -- no basta "ausente"/"false", debe llegar `true`.
  consentimientoAvisoPrivacidad: z.literal(true, { message: "Debes aceptar el aviso de privacidad para completar el check-in." }),
});

interface LinkPublicRow {
  hotel_name: string;
  guest_full_name: string | null;
  check_in_date: string;
  check_out_date: string;
  status: string;
  expires_at: string;
}

export function checkinOnlineRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/checkin-link",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/reservas/:reservationId/checkin-link", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");

    // auditoria-2/seguridad+datos [CRITICO, D1/S1]: verifica que `reservationId`
    // pertenezca REALMENTE a `hotelId` ANTES de emitir el enlace -- mismo patrón que sus
    // rutas hermanas (reservas.ts: `where id = $2 and hotel_id = $3`). Defensa en
    // profundidad: la FK compuesta `checkin_link_reservation_hotel_fk`
    // (packages/db/migrations/0061) ya hace este INSERT estructuralmente imposible si
    // hay discrepancia, pero sin este chequeo previo el INSERT fallaría con un error de
    // FK genérico (500) en vez de un 404 claro.
    const { rows: reservationRows } = await db.query<{ id: string }>(
      "select id from public.reservation where id = $1 and hotel_id = $2;",
      [reservationId, hotelId],
    );
    if (reservationRows.length === 0) throw Errors.notFound("Reserva no encontrada en este hotel.");

    // Invalida cualquier enlace pendiente anterior de esta reserva ANTES de emitir el
    // nuevo -- el índice único parcial (0054) exige que nunca haya dos "pendiente" a
    // la vez para la misma reserva.
    await db.query(
      "update public.checkin_link set status = 'expirado' where reservation_id = $1 and status = 'pendiente';",
      [reservationId],
    );

    const token = randomBytes(32).toString("hex");
    const { rows } = await db.query<{ id: string; token: string; expires_at: string }>(
      `insert into public.checkin_link (tenant_id, hotel_id, reservation_id, token, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
       returning id, token, expires_at::text as expires_at;`,
      [orgId, hotelId, reservationId, token, String(CHECKIN_LINK_TTL_HOURS)],
    );

    return c.json({ id: rows[0]!.id, token: rows[0]!.token, expiraEn: rows[0]!.expires_at, ruta: `/checkin-publico/${rows[0]!.token}` }, 201);
  });

  app.get("/checkin-publico/:token", async (c) => {
    const token = c.req.param("token");
    const { rows } = await deps.engine.admin.query<LinkPublicRow>(
      "select * from public.get_checkin_link_public($1);",
      [token],
    );
    if (rows.length === 0) throw Errors.notFound("Enlace de check-in no encontrado.");
    const r = rows[0]!;
    if (r.status !== "pendiente") throw Errors.conflict("Este enlace de check-in ya no está disponible (usado o vencido).");

    return c.json({
      hotel: r.hotel_name,
      huesped: r.guest_full_name,
      checkIn: r.check_in_date,
      checkOut: r.check_out_date,
      expiraEn: r.expires_at,
    });
  });

  app.post("/checkin-publico/:token", async (c) => {
    const token = c.req.param("token");
    const body = parseBody(completarSchema, await c.req.json().catch(() => ({})));

    let parsed;
    try {
      parsed = parsePassportMrz(body.mrzLine1, body.mrzLine2);
    } catch (err) {
      if (err instanceof InvalidMrzError) throw Errors.validation(`MRZ inválida: ${err.message}`);
      throw err;
    }

    const key = loadIdentityVaultEncryptionKey();
    const encrypted = encryptIdentityField(parsed.documentNumber, key);
    const last4 = parsed.documentNumber.slice(-4).padStart(4, "0");

    try {
      const { rows } = await deps.engine.admin.query<{
        submission_id: string;
        reservation_id: string;
        hotel_id: string;
        tenant_id: string;
      }>(
        `select * from public.complete_checkin_public($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          token,
          body.nombreCompleto,
          body.email ?? null,
          body.telefono ?? null,
          body.etaEstimada ?? null,
          body.rfc ?? null,
          body.firmaDataUrl,
          parsed.documentType,
          parsed.nationality,
          last4,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
        ],
      );
      const row = rows[0]!;

      // auditoria-2/legal [ALTO]: registra el consentimiento (schema `consent`,
      // migración 0068) con el hotel/org REALES de la reserva (nunca los del enlace,
      // mismo criterio que la propia función) -- no bloquea la respuesta al huésped si
      // este INSERT fallara por algo inesperado, pero SÍ queda logueado (nunca se traga
      // el error en silencio).
      try {
        await deps.engine.admin.query(
          "select public.record_consent($1, $2, $3, null, 'checkin_online', 'tratamiento_datos', $4, true);",
          [row.tenant_id, row.hotel_id, row.reservation_id, PRIVACY_NOTICE_VERSION],
        );
      } catch (consentErr) {
        deps.logger.error({ err: consentErr, reservationId: row.reservation_id }, "no se pudo registrar el consentimiento de check-in online");
      }

      return c.json({ id: row.submission_id, reservationId: row.reservation_id }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/checkin_link_no_encontrado/.test(message)) throw Errors.notFound("Enlace de check-in no encontrado.");
      if (/checkin_link_ya_usado/.test(message)) throw Errors.conflict("Este enlace de check-in ya fue utilizado.");
      if (/checkin_link_expirado/.test(message)) throw Errors.conflict("Este enlace de check-in ya venció.");
      if (/firma_requerida/.test(message)) throw Errors.validation("La firma de registro es obligatoria.");
      throw err;
    }
  });

  return app;
}
