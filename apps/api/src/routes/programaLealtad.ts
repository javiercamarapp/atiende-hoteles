// REQ-CRM-008 (P2/F): "programa de lealtad propio (tarifa directa con descuento, late
// checkout, crédito F&B, reconocimiento) gestionado desde CRM/WhatsApp". La "tarifa
// directa con descuento" ya se gestiona en `routes/clubSegundoViaje.ts`
// (REQ-RES-010) sobre la MISMA membresía; este archivo agrega la configuración y el
// canje de los 3 beneficios restantes, montado sobre la misma tabla de membresía.
//
// "gestionado desde CRM/WhatsApp": el canje expone un campo `canal` explícito
// ('crm' | 'whatsapp') -- la MISMA API la usa el panel de huésped normal y (cuando el
// staff resuelve una conversación desde `routes/mensajeria.ts`) la bandeja de
// WhatsApp, sin duplicar lógica de negocio en dos lugares.
import { Hono } from "hono";
import { z } from "zod";
import {
  assertValidFnbCreditAmount,
  assertValidLateCheckoutHours,
  assertValidReconocimientoTexto,
  LOYALTY_REDEEMABLE_BENEFIT_TYPES,
  LOYALTY_REDEMPTION_CHANNELS,
} from "@atiende-hoteles/domain-hotel";
import { loadLoyaltyMembership } from "../domain/clubSegundoViaje.ts";
import { listLoyaltyRedemptions, loadLoyaltyBenefitsConfig, redeemLoyaltyBenefit } from "../domain/programaLealtad.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// `.nullable()`: mandar `null` explícito deshabilita el beneficio (mismo criterio que
// dejar la columna en NULL, migración 0130) -- distinto de omitir el campo, que deja
// el valor configurado anteriormente sin tocar (PATCH parcial).
const configSchema = z.object({
  lateCheckoutHours: z.number().nullable().optional(),
  fnbCreditAmount: z.number().nullable().optional(),
  reconocimientoTexto: z.string().nullable().optional(),
});

const canjeSchema = z.object({
  canal: z.enum(LOYALTY_REDEMPTION_CHANNELS),
});

const REJECT_MESSAGES: Record<string, string> = {
  miembro_inactivo: "El huésped no tiene una membresía activa del programa de lealtad.",
  beneficio_no_configurado: "Este beneficio no está configurado/habilitado para el hotel.",
};

export function programaLealtadRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/programa-lealtad*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/huespedes/:guestId/programa-lealtad*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/programa-lealtad/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const config = await loadLoyaltyBenefitsConfig(db, hotelId);
    return c.json(config);
  });

  // Solo owner/gm configuran los beneficios (compromiso económico/operativo real del
  // hotel) -- mismo criterio que club-segundo-viaje/config (REQ-RES-010).
  app.put("/hoteles/:hotelId/programa-lealtad/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));

    try {
      if (body.lateCheckoutHours !== undefined && body.lateCheckoutHours !== null) {
        assertValidLateCheckoutHours(body.lateCheckoutHours);
      }
      if (body.fnbCreditAmount !== undefined && body.fnbCreditAmount !== null) {
        assertValidFnbCreditAmount(body.fnbCreditAmount);
      }
      if (body.reconocimientoTexto !== undefined && body.reconocimientoTexto !== null) {
        assertValidReconocimientoTexto(body.reconocimientoTexto);
      }
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : String(err));
    }

    // PATCH parcial: un campo ausente en el body deja el valor previamente configurado
    // sin tocar (`coalesce`); un campo `null` explícito SÍ lo deshabilita. Requiere una
    // fila previa (creada por PUT .../club-segundo-viaje/config, REQ-RES-010) -- si el
    // hotel nunca configuró ni siquiera el descuento, se crea aquí con el default de
    // `discount_pct` (10, migración 0123).
    const hasLateCheckout = body.lateCheckoutHours !== undefined;
    const hasFnbCredit = body.fnbCreditAmount !== undefined;
    const hasReconocimiento = body.reconocimientoTexto !== undefined;

    const { rows } = await db.query<{
      late_checkout_hours: number | null;
      fnb_credit_amount: string | null;
      reconocimiento_texto: string | null;
    }>(
      `insert into public.hotel_loyalty_program_config (hotel_id, tenant_id, late_checkout_hours, fnb_credit_amount, reconocimiento_texto)
       values ($1, $2, $3, $4, $5)
       on conflict (hotel_id) do update set
         late_checkout_hours = case when $6 then excluded.late_checkout_hours else hotel_loyalty_program_config.late_checkout_hours end,
         fnb_credit_amount = case when $7 then excluded.fnb_credit_amount else hotel_loyalty_program_config.fnb_credit_amount end,
         reconocimiento_texto = case when $8 then excluded.reconocimiento_texto else hotel_loyalty_program_config.reconocimiento_texto end,
         updated_at = now()
       returning late_checkout_hours, fnb_credit_amount::text as fnb_credit_amount, reconocimiento_texto;`,
      [
        hotelId,
        orgId,
        body.lateCheckoutHours ?? null,
        body.fnbCreditAmount ?? null,
        body.reconocimientoTexto ?? null,
        hasLateCheckout,
        hasFnbCredit,
        hasReconocimiento,
      ],
    );
    const row = rows[0]!;
    return c.json({
      lateCheckoutHours: row.late_checkout_hours,
      fnbCreditAmount: row.fnb_credit_amount === null ? null : Number(row.fnb_credit_amount),
      reconocimientoTexto: row.reconocimiento_texto,
    });
  });

  // Estado completo del programa para UN huésped: membresía + historial de canjes --
  // lo que el CRM/la bandeja de WhatsApp muestra al staff antes de otorgar un
  // beneficio nuevo.
  app.get("/hoteles/:hotelId/huespedes/:guestId/programa-lealtad", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    const [membership, canjes] = await Promise.all([
      loadLoyaltyMembership(db, hotelId, guestId),
      listLoyaltyRedemptions(db, hotelId, guestId),
    ]);

    return c.json({
      inscrito: membership !== null,
      estado: membership?.status ?? null,
      codigoMiembro: membership?.memberCode ?? null,
      canjes: canjes.map((r) => ({
        id: r.id,
        tipo: r.benefitType,
        canal: r.canal,
        lateCheckoutHours: r.lateCheckoutHours,
        fnbCreditAmount: r.fnbCreditAmount,
        reconocimientoTexto: r.reconocimientoTexto,
        canjeadoEn: r.redeemedAt,
      })),
    });
  });

  // Canje puntual de un beneficio (REQ-CRM-008, distinto del descuento automático de
  // REQ-RES-010): fail-closed -- 409 si el huésped no es miembro activo o si el
  // beneficio no está configurado, nunca inserta un canje "a medias".
  app.post("/hoteles/:hotelId/huespedes/:guestId/programa-lealtad/beneficios/:tipo/canjear", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const staffUserId = c.get("userId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const tipoParam = c.req.param("tipo");

    if (!(LOYALTY_REDEEMABLE_BENEFIT_TYPES as readonly string[]).includes(tipoParam)) {
      throw Errors.validation(`tipo debe ser uno de: ${LOYALTY_REDEEMABLE_BENEFIT_TYPES.join(", ")}.`);
    }
    const tipo = tipoParam as (typeof LOYALTY_REDEEMABLE_BENEFIT_TYPES)[number];

    const body = parseBody(canjeSchema, await c.req.json().catch(() => ({})));

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    const result = await redeemLoyaltyBenefit(db, {
      orgId,
      hotelId,
      guestId,
      benefitType: tipo,
      canal: body.canal,
      staffUserId,
    });

    if (!result.applies) {
      throw Errors.conflict(REJECT_MESSAGES[result.motivoRechazo] ?? "El beneficio no pudo canjearse.");
    }

    return c.json(
      {
        canjeado: true,
        canjeId: result.redemption.id,
        tipo: result.redemption.benefitType,
        canal: result.redemption.canal,
        lateCheckoutHours: result.redemption.lateCheckoutHours,
        fnbCreditAmount: result.redemption.fnbCreditAmount,
        reconocimientoTexto: result.redemption.reconocimientoTexto,
        canjeadoEn: result.redemption.redeemedAt,
      },
      201,
    );
  });

  return app;
}
