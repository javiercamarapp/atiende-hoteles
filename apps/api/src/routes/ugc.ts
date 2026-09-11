// REQ-CRM-010 (P3/F) · "El sistema debe capturar contenido generado por el huésped (UGC)
// vía WhatsApp post-estancia con registro explícito de consentimiento de uso, y generar
// un calendario mensual de contenido/publicaciones." (H05-005, H05-018).
//
// Tres rutas:
//  - `POST /hoteles/:hotelId/huespedes/:guestId/ugc`: registra una captura de UGC
//    (foto/video/texto) para una reserva YA finalizada del huésped, junto con el
//    consentimiento explícito de USO en la MISMA llamada (`capture_guest_ugc()`,
//    migración 0131 -- valida "post-estancia" y escribe en el ledger de consentimiento
//    de REQ-HUE-024, `consent_kind='ugc'`). "vía WhatsApp": el canal queda fijo en
//    'whatsapp' -- este endpoint representa la captura que dispara la conversación real
//    de WhatsApp post-estancia (mismo criterio de "dependencia: ninguna" que
//    REQ-HUE-024: no requiere credenciales nuevas de Meta para existir como
//    funcionalidad real).
//  - `GET /hoteles/:hotelId/ugc`: lista lo capturado (con el consentimiento ligado a
//    cada pieza) -- solo owner/gm, es un reporte de contenido, no una operación de piso.
//  - `GET /hoteles/:hotelId/ugc/calendario`: genera el calendario mensual de
//    publicaciones (`generateMonthlyContentCalendar()`, `@atiende-hoteles/domain-hotel`)
//    -- el criterio de aceptación exacto que este REQ pide poder verificar: SOLO UGC con
//    consentimiento otorgado puede aparecer en el calendario ("UGC sin consentimiento →
//    0 uso permitido").
import { Hono } from "hono";
import { z } from "zod";
import {
  generateMonthlyContentCalendar,
  ugcMediaTypeSchema,
  type GuestUgcSubmission,
} from "@atiende-hoteles/domain-hotel";
import { captureGuestUgc, loadGuestUgcSubmissions } from "../domain/ugc.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const capturarUgcSchema = z.object({
  reservationId: z.string().uuid(),
  mediaType: ugcMediaTypeSchema,
  mediaReference: z.string().trim().min(1).max(500),
  caption: z.string().trim().max(2000).optional(),
  granted: z.boolean(),
  avisoVersion: z.string().trim().min(1).max(60),
});

const calendarioQuerySchema = z.object({
  mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "mes debe tener formato yyyy-mm"),
  postsPorSemana: z.coerce.number().int().min(1).max(30).default(2),
});

function toApiSubmission(s: GuestUgcSubmission) {
  return {
    id: s.id,
    guestId: s.guestId,
    reservationId: s.reservationId,
    tipoMedia: s.mediaType,
    referenciaMedia: s.mediaReference,
    caption: s.caption,
    consentimientoOtorgado: s.consentGranted,
    capturadoEn: s.capturedAt,
  };
}

export function ugcRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/huespedes/:guestId/ugc",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use("/hoteles/:hotelId/ugc", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.use(
    "/hoteles/:hotelId/ugc/calendario",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Capturar (frontdesk/reservations/gm/owner -- quien atiende al huésped, mismo
  // criterio de rol que consentimiento.ts): exige que la reserva referida ya esté
  // post-estancia y un consentimiento explícito (`granted`) en la misma llamada -- nunca
  // se captura "para preguntar consentimiento después".
  app.post("/hoteles/:hotelId/huespedes/:guestId/ugc", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const body = parseBody(capturarUgcSchema, await c.req.json().catch(() => ({})));

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    try {
      const submission = await captureGuestUgc(db, {
        tenantId: orgId,
        hotelId,
        guestId,
        reservationId: body.reservationId,
        mediaType: body.mediaType,
        mediaReference: body.mediaReference,
        caption: body.caption ?? null,
        avisoVersion: body.avisoVersion,
        granted: body.granted,
      });
      return c.json(toApiSubmission(submission), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/reserva_no_encontrada/.test(message)) throw Errors.notFound("La reserva no pertenece a este huésped/hotel.");
      if (/reserva_no_finalizada/.test(message)) {
        throw Errors.conflict("El UGC solo se captura post-estancia: la reserva aún no llega a check_out.");
      }
      if (/media_reference_requerida/.test(message)) throw Errors.validation("Se requiere una referencia del contenido capturado.");
      if (/aviso_version_requerida/.test(message)) throw Errors.validation("Se requiere la versión del aviso aceptado.");
      throw err;
    }
  });

  // Listar (owner/gm -- reporte de contenido, no una acción de piso).
  app.get("/hoteles/:hotelId/ugc", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const submissions = await loadGuestUgcSubmissions(db, hotelId);
    return c.json({ submissions: submissions.map(toApiSubmission) });
  });

  // Generar el calendario mensual de publicaciones (lo que el REQ pide poder
  // "generar"): SOLO UGC con `consentimientoOtorgado=true` puede aparecer -- verificado
  // por `generateMonthlyContentCalendar()` (defensa en profundidad, ver
  // ugcContentCalendar.ts), no por este handler.
  app.get("/hoteles/:hotelId/ugc/calendario", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = parseBody(calendarioQuerySchema, {
      mes: c.req.query("mes"),
      postsPorSemana: c.req.query("postsPorSemana") ?? undefined,
    });

    const submissions = await loadGuestUgcSubmissions(db, hotelId);
    const calendar = generateMonthlyContentCalendar(submissions, { month: query.mes, postsPerWeek: query.postsPorSemana });

    return c.json({
      mes: calendar.month,
      publicaciones: calendar.entries.map((e) => ({
        fecha: e.date,
        submissionId: e.submissionId,
        guestId: e.guestId,
        tipoMedia: e.mediaType,
        referenciaMedia: e.mediaReference,
        caption: e.caption,
      })),
      contenidoUsableSinCupo: calendar.leftoverUsableCount,
      excluidoPorFaltaDeConsentimiento: calendar.excludedByConsentCount,
    });
  });

  return app;
}
