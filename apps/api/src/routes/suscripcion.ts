// H12c · LAUNCH-015: facturación SaaS del hotel (Atiende cobrando AL HOTEL/org). Ver
// packages/mcp-servers/billing (BillingProviderPort), packages/db/migrations/0110-0114
// (plan/subscription/entitlement/invoice_saas/billing_webhook_event) y su README (precios
// PROPUESTA, pendientes de aprobación del fundador -- docs/BLOQUEOS.md D-007).
//
// Rutas:
//   GET  /planes                                  -- catálogo público de planes (autenticado)
//   GET  /hoteles/:hotelId/suscripcion             -- estado + uso real vs límites
//   POST /hoteles/:hotelId/suscripcion/checkout    -- crea sesión de checkout (owner/gm)
//   POST /hoteles/:hotelId/suscripcion/portal      -- crea sesión del portal (owner/gm)
//   GET  /hoteles/:hotelId/suscripcion/facturas    -- historial de invoice_saas
//   POST /hoteles/:hotelId/entitlement/verificar   -- ejercita check_entitlement() en vivo
//        (endpoint de referencia: cualquier ruta de creación de hotel/habitación/agente/
//        mensaje puede copiar este patrón con `requireEntitlement`, ver lib/entitlement.ts)
//   POST /webhooks/billing                          -- público, HMAC + idempotencia
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertEntitlement, type EntitlementResource } from "../lib/entitlement.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_mxn_cents: number | null;
  currency: string;
  billing_cycle: string;
  max_hoteles: number | null;
  max_habitaciones: number | null;
  max_agentes_activos: number | null;
  max_mensajes_mes: number | null;
  es_propuesta: boolean;
}

function planBody(row: PlanRow) {
  return {
    id: row.id,
    codigo: row.code,
    nombre: row.name,
    precioMxnCentavos: row.price_mxn_cents,
    moneda: row.currency,
    ciclo: row.billing_cycle,
    limites: {
      hoteles: row.max_hoteles,
      habitaciones: row.max_habitaciones,
      agentesActivos: row.max_agentes_activos,
      mensajesMes: row.max_mensajes_mes,
    },
    esPropuesta: row.es_propuesta,
  };
}

interface SubscriptionRow {
  id: string;
  status: string;
  trial_ends_at: string;
  current_period_start: string;
  current_period_end: string;
  currency: string;
  billing_provider: string;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  cancel_at_period_end: boolean;
  plan_id: string;
}

interface UsageRow {
  hoteles: number;
  habitaciones: number;
  agentes_activos: number;
  mensajes_mes: number;
}

const checkoutSchema = z.object({
  planCode: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const portalSchema = z.object({
  returnUrl: z.string().url(),
});

const entitlementCheckSchema = z.object({
  recurso: z.enum(["hoteles", "habitaciones", "agentes_activos", "mensajes_mes"]),
  incremento: z.number().int().positive().default(1),
});

const billingWebhookHeader = "x-billing-signature";

export function suscripcionRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/suscripcion*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.use("/hoteles/:hotelId/entitlement/*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));

  // `GET /planes` es PÚBLICO a propósito (sin authMiddleware/dbSession): la landing
  // pública (apps/web/src/pages/Landing.tsx, LAUNCH-025) muestra los 3 planes
  // propuestos sin exigir sesión -- no es dato de ningún tenant, es catálogo de
  // producto (mismo criterio que `experienciasPublicas.ts`). Usa el cliente ADMIN
  // porque no hay sesión RLS que abrir; la policy `plan_authenticated_select` (0110)
  // de todas formas solo cubre lectura para `authenticated`, así que un visitante sin
  // cuenta necesita esta vía explícita, nunca acceso directo a la tabla.
  app.get("/planes", async (c) => {
    const { rows } = await deps.engine.admin.query<PlanRow>(
      "select id, code, name, price_mxn_cents, currency, billing_cycle, max_hoteles, max_habitaciones, max_agentes_activos, max_mensajes_mes, es_propuesta from public.plan order by price_mxn_cents nulls last;",
    );
    return c.json(rows.map(planBody));
  });

  app.get("/hoteles/:hotelId/suscripcion", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");

    const { rows } = await db.query<SubscriptionRow>(
      `select id, status, trial_ends_at::text, current_period_start::text, current_period_end::text,
              currency, billing_provider, external_customer_id, external_subscription_id,
              cancel_at_period_end, plan_id
       from public.subscription where org_id = $1;`,
      [orgId],
    );
    if (rows.length === 0) {
      throw Errors.notFound("Esta organización aún no tiene una suscripción.");
    }
    const sub = rows[0]!;
    const { rows: planRows } = await db.query<PlanRow>(
      "select id, code, name, price_mxn_cents, currency, billing_cycle, max_hoteles, max_habitaciones, max_agentes_activos, max_mensajes_mes, es_propuesta from public.plan where id = $1;",
      [sub.plan_id],
    );
    const { rows: usageRows } = await db.query<UsageRow>("select * from public.entitlement_usage($1);", [orgId]);
    const usage = usageRows[0]!;

    return c.json({
      id: sub.id,
      estado: sub.status,
      trialTermina: sub.trial_ends_at,
      periodoInicio: sub.current_period_start,
      periodoFin: sub.current_period_end,
      moneda: sub.currency,
      proveedor: sub.billing_provider,
      cancelaAlFinDelPeriodo: sub.cancel_at_period_end,
      plan: planRows[0] ? planBody(planRows[0]) : null,
      uso: {
        hoteles: usage.hoteles,
        habitaciones: usage.habitaciones,
        agentesActivos: usage.agentes_activos,
        mensajesMes: usage.mensajes_mes,
      },
    });
  });

  app.get("/hoteles/:hotelId/suscripcion/facturas", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const { rows } = await db.query<{
      id: string;
      period_start: string;
      period_end: string;
      amount_mxn_cents: number;
      currency: string;
      status: string;
      cfdi_uuid: string | null;
      created_at: string;
      paid_at: string | null;
    }>(
      `select id, period_start::text, period_end::text, amount_mxn_cents, currency, status, cfdi_uuid,
              created_at::text, paid_at::text
       from public.invoice_saas where org_id = $1 order by period_start desc;`,
      [orgId],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        periodoInicio: r.period_start,
        periodoFin: r.period_end,
        montoMxnCentavos: r.amount_mxn_cents,
        moneda: r.currency,
        estado: r.status,
        cfdiUuid: r.cfdi_uuid,
        creadaEn: r.created_at,
        pagadaEn: r.paid_at,
      })),
    );
  });

  app.post("/hoteles/:hotelId/suscripcion/checkout", async (c) => {
    if (!ADMIN_ROLES.includes(c.get("hotelRole") as (typeof ADMIN_ROLES)[number])) {
      throw Errors.forbidden("Solo el propietario/gerencia puede cambiar el plan de facturación.");
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const userEmail = c.get("userEmail");
    const input = parseBody(checkoutSchema, await c.req.json().catch(() => ({})));

    const { rows: planRows } = await db.query<{ id: string }>("select id from public.plan where code = $1;", [input.planCode]);
    if (planRows.length === 0) throw Errors.validation(`El plan "${input.planCode}" no existe.`);

    // Simulación honesta de "cliente ya existente en el proveedor": determinista por
    // org, para que el webhook de la prueba adversarial pueda referenciarlo de vuelta
    // sin depender de un flujo de creación de cliente real (sin credenciales, ver README
    // de packages/mcp-servers/billing).
    const externalCustomerId = `fake-cust-${orgId}`;

    const session = await deps.billing.createCheckoutSession({
      orgId,
      planCode: input.planCode,
      customerEmail: userEmail,
      externalCustomerId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: `checkout:${orgId}:${input.planCode}`,
    });

    await db.query(
      `insert into public.subscription (org_id, plan_id, status, billing_provider, external_customer_id)
       values ($1, $2, 'trial', 'fake', $3)
       on conflict (org_id) do update set external_customer_id = excluded.external_customer_id, updated_at = now();`,
      [orgId, planRows[0]!.id, externalCustomerId],
    );

    return c.json({ checkoutUrl: session.checkoutUrl, externalSessionId: session.externalSessionId }, 201);
  });

  app.post("/hoteles/:hotelId/suscripcion/portal", async (c) => {
    if (!ADMIN_ROLES.includes(c.get("hotelRole") as (typeof ADMIN_ROLES)[number])) {
      throw Errors.forbidden("Solo el propietario/gerencia puede abrir el portal de facturación.");
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const input = parseBody(portalSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ external_customer_id: string | null }>(
      "select external_customer_id from public.subscription where org_id = $1;",
      [orgId],
    );
    if (rows.length === 0 || !rows[0]!.external_customer_id) {
      throw Errors.validation("Esta organización todavía no tiene un cliente de facturación (inicia un checkout primero).");
    }

    const session = await deps.billing.createPortalSession({
      externalCustomerId: rows[0]!.external_customer_id,
      returnUrl: input.returnUrl,
    });
    return c.json({ portalUrl: session.portalUrl });
  });

  // Endpoint de REFERENCIA: ejercita `check_entitlement()` en vivo contra el uso real de
  // la org (nunca un cálculo aparte en JS que pudiera desincronizarse). Cualquier ruta de
  // creación real de hotel/habitación/agente/mensaje puede envolverse igual con
  // `requireEntitlement()` (lib/entitlement.ts) -- ver el comentario de ese archivo sobre
  // por qué no se cableó directamente en hoteles.ts/agentes.ts/mensajeria.ts en este hito.
  app.post("/hoteles/:hotelId/entitlement/verificar", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const input = parseBody(entitlementCheckSchema, await c.req.json().catch(() => ({})));
    await assertEntitlement(db, orgId, input.recurso as EntitlementResource, input.incremento);
    return c.json({ permitido: true });
  });

  // --- Webhook público (sin sesión de staff), HMAC + idempotencia persistida --------
  app.post("/webhooks/billing", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header(billingWebhookHeader);

    let event;
    try {
      event = await deps.billing.verifyAndNormalizeWebhook(rawBody, signature);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/WebhookSignatureError|firma/i.test(message)) throw Errors.forbidden("Firma de webhook inválida.");
      if (/WebhookReplayError|repetido|ya se proces/i.test(err instanceof Error ? err.name + err.message : message)) {
        return c.json({ recibido: true, duplicado: true }, 200);
      }
      throw err;
    }

    const provider = deps.billing.status().provider;
    const claimed = await deps.engine.admin.query<{ claim_billing_webhook_event: boolean }>(
      "select public.claim_billing_webhook_event($1, $2, $3, $4) as claim_billing_webhook_event;",
      [provider, event.eventId, event.type, JSON.stringify(event.raw)],
    );
    if (!claimed.rows[0]!.claim_billing_webhook_event) {
      // Ya se procesó este evento antes (persistido, sobrevive un reinicio) -- 200 sin
      // reaplicar ningún efecto, nunca un error (los proveedores reintentan igual).
      return c.json({ recibido: true, duplicado: true }, 200);
    }

    if (!event.externalCustomerId) {
      return c.json({ recibido: true, aplicado: false, razon: "sin externalCustomerId" }, 200);
    }

    const { rows: subRows } = await deps.engine.admin.query<{ id: string; org_id: string }>(
      "select id, org_id from public.subscription where external_customer_id = $1;",
      [event.externalCustomerId],
    );
    if (subRows.length === 0) {
      return c.json({ recibido: true, aplicado: false, razon: "suscripción no encontrada para ese cliente" }, 200);
    }
    const sub = subRows[0]!;

    if (event.type === "subscription.updated" && event.status) {
      await deps.engine.admin.query(
        `update public.subscription
         set status = $2, external_subscription_id = coalesce($3, external_subscription_id), updated_at = now()
         where id = $1;`,
        [sub.id, event.status, event.externalSubscriptionId ?? null],
      );
    } else if (event.type === "subscription.canceled") {
      await deps.engine.admin.query(
        "update public.subscription set status = 'cancelada', updated_at = now() where id = $1;",
        [sub.id],
      );
    } else if (event.type === "invoice.paid") {
      await deps.engine.admin.query(
        `insert into public.invoice_saas (org_id, subscription_id, period_start, period_end, amount_mxn_cents, status, external_invoice_id, paid_at)
         select $1, $2, current_period_start::date, current_period_end::date,
                coalesce(p.price_mxn_cents, 0), 'pagada', $3, now()
         from public.subscription s join public.plan p on p.id = s.plan_id
         where s.id = $2;`,
        [sub.org_id, sub.id, event.eventId],
      );
    } else if (event.type === "invoice.payment_failed") {
      await deps.engine.admin.query(
        "update public.subscription set status = 'vencida', updated_at = now() where id = $1;",
        [sub.id],
      );
    }

    return c.json({ recibido: true, aplicado: true });
  });

  return app;
}
