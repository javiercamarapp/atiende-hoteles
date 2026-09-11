// REQ-RES-016 · check-in online de UN SOLO USO (formulario web -- el WhatsApp Flow
// cifrado queda documentado como bloqueado por credencial real de Meta, ver
// docs/cierre-p0/inventario.md §2). El "pago/garantía" tampoco se simula aquí (requiere
// pasarela real, misma dependencia ya declarada para REQ-RES-003/008) -- esta ruta
// captura lo que SÍ es real sin ninguna credencial: datos del huésped, identidad
// (MRZ validada + bóveda cifrada, reutilizando REQ-REC-011 sin duplicar su lógica),
// firma de registro, ETA y RFC.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { parsePassportMrz, InvalidMrzError, esContactoEnmascaradoPorOta } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import { encryptIdentityField, loadIdentityVaultEncryptionKey } from "../lib/identityEncryption.ts";
import type { DbClient } from "@atiende-hoteles/db";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const CHECKIN_LINK_TTL_HOURS = 72;
const RFC_PATTERN = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/i;

// REQ-RES-018: consentimiento explícito de contacto-ota; body vacío -- solo activa/
// desactiva el flag y, opcionalmente, deja constancia del canal de OTA de origen si la
// reserva todavía lo tenía en 'directo' (staff registrando a mano una reserva que llegó
// por una OTA sin conector real, ver comentario de migración 0130).
const marcarContactoOtaSchema = z.object({
  enmascaradoPorOta: z.boolean(),
  canalOta: z.string().trim().min(1).max(40).optional(),
});

/**
 * Emite (o reemplaza, si ya había uno pendiente) el `checkin_link` de una reserva --
 * MISMA lógica exacta que el `POST .../checkin-link` original de abajo, extraída para
 * que la ruta nueva `POST .../checkin-link-ota` (REQ-RES-018) no duplique el SQL de
 * invalidar+insertar y ambas queden garantizadas a nunca divergir en el criterio de
 * "un solo enlace pendiente a la vez" (índice único parcial, migración 0054).
 */
async function issueCheckinLink(
  db: DbClient,
  params: { orgId: string; hotelId: string; reservationId: string },
): Promise<{ id: string; token: string; expiresAt: string }> {
  await db.query(
    "update public.checkin_link set status = 'expirado' where reservation_id = $1 and status = 'pendiente';",
    [params.reservationId],
  );
  const token = randomBytes(32).toString("hex");
  const { rows } = await db.query<{ id: string; token: string; expires_at: string }>(
    `insert into public.checkin_link (tenant_id, hotel_id, reservation_id, token, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
     returning id, token, expires_at::text as expires_at;`,
    [params.orgId, params.hotelId, params.reservationId, token, String(CHECKIN_LINK_TTL_HOURS)],
  );
  const row = rows[0]!;
  return { id: row.id, token: row.token, expiresAt: row.expires_at };
}

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
  // REQ-RES-018: mismas 3 capas de middleware (staff autenticado + sesión RLS + membresía
  // del hotel) que la ruta hermana de arriba -- `app.use()` de Hono solo aplica al patrón
  // EXACTO registrado, así que cada ruta nueva bajo `reservas/:reservationId/` necesita su
  // propio registro (no un wildcard que también capturaría, por accidente, cualquier otra
  // sub-ruta futura de reservas).
  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/contacto-ota",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/checkin-link-ota",
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

    const link = await issueCheckinLink(db, { orgId, hotelId, reservationId });
    return c.json({ id: link.id, token: link.token, expiraEn: link.expiresAt, ruta: `/checkin-publico/${link.token}` }, 201);
  });

  // REQ-RES-018: staff marca (o desmarca) a mano que el teléfono/email de esta reserva
  // es hoy el relay enmascarado de la OTA de origen -- caso real de hoy (front desk
  // registrando una reserva que llegó por Booking/Expedia/Airbnb sin que exista todavía
  // un conector automático que lo detecte, ver comentario de migración 0130). Reutiliza
  // la policy de UPDATE ya existente de `reservation` (owner/gm/frontdesk/reservations,
  // migración 0006) -- ninguna función SECURITY DEFINER nueva hace falta.
  app.patch("/hoteles/:hotelId/reservas/:reservationId/contacto-ota", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");
    const body = parseBody(marcarContactoOtaSchema, await c.req.json().catch(() => ({})));

    const { rows: reservationRows } = await db.query<{ id: string; channel: string }>(
      "select id, channel from public.reservation where id = $1 and hotel_id = $2;",
      [reservationId, hotelId],
    );
    if (reservationRows.length === 0) throw Errors.notFound("Reserva no encontrada en este hotel.");
    const reservation = reservationRows[0]!;

    const nextChannel = body.canalOta ?? reservation.channel;
    // REQ-RES-022/REQ-REV-008 siguen vigentes -- este endpoint solo REGISTRA el dato ya
    // real de qué OTA originó la reserva y si su contacto sigue enmascarado, nunca
    // construye ni simula una integración con esa OTA. Marcar `enmascaradoPorOta: true`
    // sin un canal de OTA (ni explícito ni ya existente) sería un dato imposible: una
    // reserva 'directo' nunca tiene contacto enmascarado por definición (ver
    // `esContactoEnmascaradoPorOta`).
    if (body.enmascaradoPorOta && !esContactoEnmascaradoPorOta({ channel: nextChannel, guestContactMaskedByOta: true })) {
      throw Errors.validation(
        "No se puede marcar contacto enmascarado por OTA en una reserva de canal 'directo' -- indica primero `canalOta` (p. ej. 'booking_com', 'airbnb', 'expedia').",
      );
    }

    const { rows } = await db.query<{ channel: string; guest_contact_masked_by_ota: boolean }>(
      `update public.reservation
       set channel = $3, guest_contact_masked_by_ota = $4
       where id = $1 and hotel_id = $2
       returning channel, guest_contact_masked_by_ota;`,
      [reservationId, hotelId, nextChannel, body.enmascaradoPorOta],
    );
    const updated = rows[0]!;
    return c.json({ canal: updated.channel, enmascaradoPorOta: updated.guest_contact_masked_by_ota });
  });

  // REQ-RES-018: emite el enlace de check-in y lo "envía" por el canal PROPIO de la OTA
  // (nunca WhatsApp/SMS/email directos) -- exige que la reserva esté marcada como
  // contacto-enmascarado-por-OTA (ruta de arriba). Sin credenciales reales de ninguna OTA
  // (REQ-RES-022/H15-006, ver migración 0130): el "envío" es el mismo mecanismo honesto
  // que `FakeWhatsappAdapter` (ADR-007) -- se registra el mensaje saliente con
  // `simulated=true` y un `externalMessageId` local, listo para que un conector real de
  // mensajería por OTA lo reemplace el día que exista esa integración certificada, sin
  // aparentar hoy una entrega que no ocurre. Lo que SÍ es real y verificado: la reserva
  // JAMÁS pasa por `conversation`/`message` de canal 'whatsapp' mientras el contacto siga
  // enmascarado (ver el gate gemelo en `packages/agent-core/src/tools/messagingTools.ts`).
  app.post("/hoteles/:hotelId/reservas/:reservationId/checkin-link-ota", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");

    const { rows: reservationRows } = await db.query<{
      id: string;
      channel: string;
      guest_contact_masked_by_ota: boolean;
      confirmation_code: string;
      guest_id: string | null;
    }>(
      "select id, channel, guest_contact_masked_by_ota, confirmation_code, guest_id from public.reservation where id = $1 and hotel_id = $2;",
      [reservationId, hotelId],
    );
    if (reservationRows.length === 0) throw Errors.notFound("Reserva no encontrada en este hotel.");
    const reservation = reservationRows[0]!;

    if (
      !esContactoEnmascaradoPorOta({
        channel: reservation.channel,
        guestContactMaskedByOta: reservation.guest_contact_masked_by_ota,
      })
    ) {
      throw Errors.conflict(
        "Esta reserva no tiene contacto enmascarado por OTA -- usa el enlace de check-in normal (`POST .../checkin-link`) o márcala primero con `PATCH .../contacto-ota`.",
      );
    }

    const link = await issueCheckinLink(db, { orgId, hotelId, reservationId });
    const checkinUrl = `/checkin-publico/${link.token}`;

    // Conversación/mensaje de canal 'ota' (migración 0130) -- nunca 'whatsapp': deja
    // constancia auditable de que ESTE fue el único contacto saliente mientras el
    // huésped seguía enmascarado, sin requerir un `guest_phone` real (justamente lo que
    // no se tiene todavía -- por eso `guest_phone` queda `null`, permitido por el índice
    // único parcial de `conversation`, migración 0044).
    const { rows: conversationRows } = await db.query<{ id: string }>(
      `insert into public.conversation (tenant_id, hotel_id, guest_id, channel, guest_phone)
       values ($1, $2, $3, 'ota', null)
       returning id;`,
      [orgId, hotelId, reservation.guest_id],
    );
    const conversationId = conversationRows[0]!.id;
    const externalMessageId = `ota-simulado-${randomUUID()}`;

    await db.query(
      `insert into public.message
         (tenant_id, hotel_id, conversation_id, direction, channel, body, requires_approval, external_message_id, delivery_status, simulated)
       values ($1, $2, $3, 'saliente', 'ota', $4, false, $5, 'enviado', true);`,
      [
        orgId,
        hotelId,
        conversationId,
        `Enlace de check-in enviado por la mensajería de la OTA (reserva ${reservation.confirmation_code}): ${checkinUrl}`,
        externalMessageId,
      ],
    );

    return c.json(
      {
        id: link.id,
        token: link.token,
        expiraEn: link.expiresAt,
        ruta: checkinUrl,
        canalEnvio: "ota",
        simulado: true,
        externalMessageId,
      },
      201,
    );
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

      // REQ-RES-018: si esta reserva tenía el contacto enmascarado por una OTA, el
      // huésped acaba de compartir su contacto REAL (`nombreCompleto`/`email`/`telefono`
      // ya se escribieron en `guest` dentro de `complete_checkin_public()`, arriba) --
      // desde este momento el desenmascarado es un hecho consumado: (a) se limpia el
      // flag (`guest_contact_masked_by_ota = false`, la condición `where ... = true` hace
      // esto idempotente y detecta si de verdad estaba enmascarada) y (b) se registra el
      // consentimiento EXPLÍCITO de revelar ese contacto real, distinto del
      // 'tratamiento_datos' genérico que TODO check-in ya registra arriba (con o sin OTA
      // de por medio) -- mismo criterio de "no tragarse el error" que el bloque anterior.
      try {
        const { rows: unmaskedRows } = await deps.engine.admin.query<{ id: string }>(
          "update public.reservation set guest_contact_masked_by_ota = false where id = $1 and guest_contact_masked_by_ota = true returning id;",
          [row.reservation_id],
        );
        if (unmaskedRows.length > 0) {
          await deps.engine.admin.query(
            "select public.record_consent($1, $2, $3, null, 'checkin_online', 'contacto_real_ota', $4, true);",
            [row.tenant_id, row.hotel_id, row.reservation_id, PRIVACY_NOTICE_VERSION],
          );
        }
      } catch (unmaskErr) {
        deps.logger.error(
          { err: unmaskErr, reservationId: row.reservation_id },
          "no se pudo desenmascarar el contacto OTA / registrar su consentimiento explícito",
        );
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
