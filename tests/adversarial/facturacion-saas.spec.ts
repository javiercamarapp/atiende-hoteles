// H12c · LAUNCH-015: pruebas adversariales de facturación SaaS.
//  1) Webhook con firma inválida se rechaza; uno válido pero repetido no se aplica dos
//     veces (idempotencia persistida, public.billing_webhook_event).
//  2) Un org ajeno NUNCA ve la suscripción de otro org (RLS real, no solo 403 de ruta).
//  3) Un límite de plan excedido bloquea la acción con un mensaje explícito (402), nunca
//     en silencio -- y una acción DENTRO del límite se permite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { hashPassword } from "@atiende-hoteles/db";
import { FakeBillingAdapter } from "@atiende-hoteles/mcp-billing";

describe("adversarial: facturación SaaS (H12c)", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("staff owner puede ver el estado de su propia suscripción (sembrada en plan pro)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const owner = hotelA.staff.find((s) => s.role === "owner")!;
    const token = await loginAs(fixture.app, owner.email);

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/suscripcion`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; plan: { codigo: string; esPropuesta: boolean } };
    expect(body.estado).toBe("trial");
    expect(body.plan.codigo).toBe("pro");
    expect(body.plan.esPropuesta).toBe(true);
  });

  it("un org ajeno NUNCA ve la suscripción de otro org (RLS real, no solo el 403 de ruta)", async () => {
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Org Ajena Billing') returning id;",
    );
    const otherOrgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Ajeno Billing') returning id;",
      [otherOrgId],
    );
    const otherHotelId = locRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [otherHotelId, otherOrgId]);
    const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ('owner@otra-org-billing.demo', 'Owner Ajeno', $1) returning id;",
      [await hashPassword("otra-org-pass")],
    );
    const otherUserId = userRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');",
      [otherOrgId, otherHotelId, otherUserId],
    );
    const { rows: planRows } = await fixture.engine.admin.query<{ id: string }>("select id from public.plan where code = 'starter';");
    await fixture.engine.admin.query(
      "insert into public.subscription (org_id, plan_id, status) values ($1, $2, 'activa');",
      [otherOrgId, planRows[0]!.id],
    );

    // Ruta HTTP: 403 explícito antes de tocar la tabla (requireHotelMembership).
    const hotelA = fixture.seed.hotels[0]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const tokenA = await loginAs(fixture.app, gmA.email);
    const res = await fixture.app.request(`/hoteles/${otherHotelId}/suscripcion`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(403);

    // RLS directa: una sesión con el rol de gmA NUNCA ve la fila del org ajeno, ni
    // siquiera consultando la tabla de suscripción a mano.
    await fixture.engine.withAppSession({ userId: gmA.id }, async (session) => {
      const { rows } = await session.query<{ id: string }>(
        "select id from public.subscription where org_id = $1;",
        [otherOrgId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("webhook de facturación con firma inválida se rechaza (403), nunca procesa el payload", async () => {
    const payload = {
      event_id: "evt-firma-invalida-1",
      type: "subscription.updated",
      external_customer_id: "fake-cust-no-existe",
      status: "activa",
      occurred_at: new Date().toISOString(),
    };
    const res = await fixture.app.request("/webhooks/billing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-billing-signature": "sha256=firma-completamente-falsa" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
  });

  it("webhook válido pero repetido (mismo event_id) NO se aplica dos veces (idempotencia persistida)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const owner = hotelA.staff.find((s) => s.role === "owner")!;
    const tokenA = await loginAs(fixture.app, owner.email);

    // Crea un checkout primero -- fija external_customer_id determinista para el org.
    const checkoutRes = await fixture.app.request(`/hoteles/${hotelA.id}/suscripcion/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro", successUrl: "https://panel.local/ok", cancelUrl: "https://panel.local/cancelado" }),
    });
    expect(checkoutRes.status).toBe(201);

    const subRes = await fixture.app.request(`/hoteles/${hotelA.id}/suscripcion`, { headers: { authorization: `Bearer ${tokenA}` } });
    const subBody = (await subRes.json()) as { id: string };
    void subBody;

    const fake = new FakeBillingAdapter();
    const payload = {
      event_id: "evt-invoice-paid-1",
      type: "invoice.paid",
      external_customer_id: `fake-cust-${fixture.seed.orgId}`,
      occurred_at: new Date().toISOString(),
    };
    const { rawBody, signature } = fake.signWebhookFixture(payload);

    const first = await fixture.app.request("/webhooks/billing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-billing-signature": signature },
      body: rawBody,
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { aplicado: boolean }).toMatchObject({ aplicado: true });

    const second = await fixture.app.request("/webhooks/billing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-billing-signature": signature },
      body: rawBody,
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { duplicado: boolean }).toMatchObject({ duplicado: true });

    const facturasRes = await fixture.app.request(`/hoteles/${hotelA.id}/suscripcion/facturas`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const facturas = (await facturasRes.json()) as unknown[];
    expect(facturas).toHaveLength(1); // exactamente 1 factura, no 2, pese al webhook repetido.
  });

  it("un límite de plan excedido bloquea la acción con un mensaje explícito (402), nunca en silencio", async () => {
    // Org nueva, aislada, en plan starter (max_hoteles = 1) con exactamente 1 hotel ya
    // creado -- crear un segundo hotel debe bloquearse.
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Org Limite Starter') returning id;",
    );
    const orgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Unico Starter') returning id;",
      [orgId],
    );
    const hotelId = locRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);
    const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ('owner@limite-starter.demo', 'Owner Starter', $1) returning id;",
      [await hashPassword("limite-starter-pass")],
    );
    const userId = userRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');",
      [orgId, hotelId, userId],
    );
    const { rows: planRows } = await fixture.engine.admin.query<{ id: string }>("select id from public.plan where code = 'starter';");
    await fixture.engine.admin.query(
      "insert into public.subscription (org_id, plan_id, status) values ($1, $2, 'activa');",
      [orgId, planRows[0]!.id],
    );

    const token = await loginAs(fixture.app, "owner@limite-starter.demo", "limite-starter-pass");

    const bloqueado = await fixture.app.request(`/hoteles/${hotelId}/entitlement/verificar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ recurso: "hoteles", incremento: 1 }),
    });
    expect(bloqueado.status).toBe(402);
    const bloqueadoBody = (await bloqueado.json()) as { code: string; message: string };
    expect(bloqueadoBody.code).toBe("entitlement_exceeded");
    expect(bloqueadoBody.message.length).toBeGreaterThan(0);

    // Dentro del límite (0 habitaciones usadas de 20) -- se permite.
    const permitido = await fixture.app.request(`/hoteles/${hotelId}/entitlement/verificar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ recurso: "habitaciones", incremento: 1 }),
    });
    expect(permitido.status).toBe(200);
    expect((await permitido.json()) as { permitido: boolean }).toMatchObject({ permitido: true });
  });

  it("una organización sin fila en `subscription` recibe fail-closed (402), nunca 'sin límite'", async () => {
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Org Sin Suscripcion') returning id;",
    );
    const orgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Sin Suscripcion') returning id;",
      [orgId],
    );
    const hotelId = locRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);
    const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ('owner@sin-suscripcion.demo', 'Owner Sin Sub', $1) returning id;",
      [await hashPassword("sin-suscripcion-pass")],
    );
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');",
      [orgId, hotelId, userRows[0]!.id],
    );
    const token = await loginAs(fixture.app, "owner@sin-suscripcion.demo", "sin-suscripcion-pass");

    const res = await fixture.app.request(`/hoteles/${hotelId}/entitlement/verificar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ recurso: "hoteles", incremento: 1 }),
    });
    expect(res.status).toBe(402);
  });
});
