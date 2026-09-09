// REQ-RES-010 (P1/F): "club de segundo viaje" -- registro con consentimiento
// explícito, código de miembro y configuración del descuento aplicado
// automáticamente en reservas directas subsecuentes (ver POST .../reservas en
// routes/reservas.ts, que llama `computeLoyaltyBenefitForNewReservation`).
import { Hono } from "hono";
import { z } from "zod";
import { assertValidLoyaltyDiscountPct } from "@atiende-hoteles/domain-hotel";
import { loadLoyaltyMembership } from "../domain/clubSegundoViaje.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const configSchema = z.object({ discountPct: z.number().min(0).max(100) });

// `.strict()`: un valor `granted: false` explícito documenta un rechazo, pero nunca se
// inserta una fila de membresía para él (ver el handler) -- capturar el rechazo en la
// respuesta es honesto, guardarlo como si fuera una inscripción no lo sería.
const inscripcionSchema = z.object({
  avisoVersion: z.string().trim().min(1).max(100),
  granted: z.boolean(),
});

export function clubSegundoViajeRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/club-segundo-viaje*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/huespedes/:guestId/club-segundo-viaje*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/club-segundo-viaje/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ discount_pct: string }>(
      "select discount_pct::text as discount_pct from public.hotel_loyalty_program_config where hotel_id = $1;",
      [hotelId],
    );
    return c.json({ discountPct: rows[0] ? Number(rows[0].discount_pct) : null });
  });

  // Solo owner/gm dan de alta el % de descuento (dinero real del hotel) -- mismo
  // criterio que hotel_channel_commission/hotel_cancellation_policy.
  app.put("/hoteles/:hotelId/club-segundo-viaje/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));

    try {
      assertValidLoyaltyDiscountPct(body.discountPct);
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : String(err));
    }

    await db.query(
      `insert into public.hotel_loyalty_program_config (hotel_id, tenant_id, discount_pct)
       values ($1, $2, $3)
       on conflict (hotel_id) do update set discount_pct = excluded.discount_pct, updated_at = now();`,
      [hotelId, orgId, body.discountPct],
    );

    return c.json({ discountPct: body.discountPct });
  });

  app.get("/hoteles/:hotelId/huespedes/:guestId/club-segundo-viaje", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const membership = await loadLoyaltyMembership(db, hotelId, guestId);
    if (!membership) return c.json({ inscrito: false });
    return c.json({
      inscrito: true,
      codigoMiembro: membership.memberCode,
      estado: membership.status,
      inscritoEn: membership.enrolledAt,
    });
  });

  // Inscripción con consentimiento EXPLÍCITO (REQ-RES-010): `granted: false` se
  // responde 200 con `inscrito: false` -- un rechazo del huésped es una respuesta
  // válida, nunca un error, y nunca crea/reactiva una fila de membresía.
  // Idempotente por construcción (upsert sobre el unique (hotel_id, guest_id)): una
  // reintentada de red que reenvía la misma inscripción no duplica nada.
  app.post("/hoteles/:hotelId/huespedes/:guestId/club-segundo-viaje/inscripcion", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const body = parseBody(inscripcionSchema, await c.req.json().catch(() => ({})));

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    if (!body.granted) {
      return c.json({ inscrito: false });
    }

    const { rows } = await db.query<{ member_code: string }>(
      `insert into public.hotel_loyalty_member (tenant_id, hotel_id, guest_id, consent_aviso_version)
       values ($1, $2, $3, $4)
       on conflict (hotel_id, guest_id)
       do update set status = 'activo', consent_aviso_version = excluded.consent_aviso_version, revoked_at = null
       returning member_code;`,
      [orgId, hotelId, guestId, body.avisoVersion],
    );

    await db.query(
      "select public.record_audit_log($1, $2, 'loyalty_member.enrolled', 'guest', $3, $4);",
      [orgId, hotelId, guestId, JSON.stringify({ avisoVersion: body.avisoVersion })],
    );

    return c.json({ inscrito: true, codigoMiembro: rows[0]!.member_code });
  });

  // Revocación: el huésped puede retirar su consentimiento en cualquier momento
  // (mismo principio de reversibilidad que el resto de `consent`/`privacidad.ts`) --
  // deja de recibir el beneficio en reservas futuras sin borrar el historial de
  // membresía (append-only del estado, nunca DELETE de la fila).
  app.post("/hoteles/:hotelId/huespedes/:guestId/club-segundo-viaje/revocar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");

    const { rows } = await db.query<{ id: string }>(
      `update public.hotel_loyalty_member
       set status = 'revocado', revoked_at = now()
       where hotel_id = $1 and guest_id = $2 and status = 'activo'
       returning id;`,
      [hotelId, guestId],
    );
    if (rows.length === 0) throw Errors.notFound("El huésped no tiene una membresía activa que revocar.");

    await db.query(
      "select public.record_audit_log($1, $2, 'loyalty_member.revoked', 'guest', $3, $4);",
      [orgId, hotelId, guestId, JSON.stringify({})],
    );

    return c.json({ inscrito: false });
  });

  return app;
}
