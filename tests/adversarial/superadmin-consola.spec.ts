// H12b · LAUNCH-007: consola superadmin cross-tenant, a nivel HTTP real (embedded-postgres,
// no PGlite) -- complementa tests/unit/rls/platform-admin.spec.ts (que ya prueba la RLS/
// función SQL). Aquí se prueba la SEGUNDA capa (routes/admin.ts `requirePlatformAdmin`,
// 403 explícito antes de tocar la función SQL) y que ser superadmin de plataforma NO
// otorga membresía de hotel: un superadmin sigue sin poder escribir datos operativos de
// un hotel del que no es staff, salvo la única acción explícita auditada
// (admin_reintentar_outbox).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: consola /admin (superadmin cross-tenant)", () => {
  let fixture: ApiFixture;
  let hotelAId: string;
  let hotelBId: string;
  let ownerHotelAEmail: string;
  let ownerHotelAId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    hotelAId = fixture.seed.hotels[0]!.id;
    hotelBId = fixture.seed.hotels[1]!.id;
    const ownerHotelA = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    ownerHotelAEmail = ownerHotelA.email;
    ownerHotelAId = ownerHotelA.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("un owner de hotel (no superadmin de plataforma) recibe 403 en /admin/negocio y /admin/auditoria", async () => {
    const token = await loginAs(fixture.app, ownerHotelAEmail);

    const negocio = await fixture.app.request("/admin/negocio", { headers: { authorization: `Bearer ${token}` } });
    expect(negocio.status).toBe(403);

    const auditoria = await fixture.app.request("/admin/auditoria", { headers: { authorization: `Bearer ${token}` } });
    expect(auditoria.status).toBe(403);

    const reintentar = await fixture.app.request(`/admin/outbox/${randomUUID()}/reintentar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reintentar.status).toBe(403);
  });

  it("sin sesión (sin Authorization) /admin/negocio responde 401, nunca datos", async () => {
    const res = await fixture.app.request("/admin/negocio");
    expect(res.status).toBe(401);
  });

  it("una vez otorgado platform_admin, el owner ve AMBOS hoteles en /admin/negocio (cruce de tenants a propósito)", async () => {
    await fixture.engine.admin.query("insert into public.platform_admin (user_id) values ($1);", [ownerHotelAId]);
    const token = await loginAs(fixture.app, ownerHotelAEmail);

    const res = await fixture.app.request("/admin/negocio", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hoteles: { hotel_id: string }[]; metricasGlobales: { hotelesTotal: number } };
    const ids = new Set(body.hoteles.map((h) => h.hotel_id));
    expect(ids.has(hotelAId)).toBe(true);
    expect(ids.has(hotelBId)).toBe(true);
    expect(body.metricasGlobales.hotelesTotal).toBe(2);
  });

  it("ser superadmin de plataforma NO otorga membresía de hotel: sigue sin poder transicionar una reserva de hotel B (403 por RLS/requireHotelMembership, no por /admin)", async () => {
    const token = await loginAs(fixture.app, ownerHotelAEmail);

    // El owner de hotel A (ahora también superadmin de plataforma) no tiene hotel_staff
    // en hotel B -- las rutas operativas normales de hotel B lo siguen rechazando igual
    // que a cualquier extraño, exactamente el criterio "todo lo demás sigue aislado".
    const res = await fixture.app.request(`/hoteles/${hotelBId}/reservas`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("la única escritura permitida desde /admin es reintentar un evento outbox en dead-letter, y queda auditada", async () => {
    const token = await loginAs(fixture.app, ownerHotelAEmail);

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, status, attempts, last_error)
       values ($1, $2, 'reservation', gen_random_uuid(), 'reservation.confirmada', 'fallido', 5, 'timeout simulado')
       returning id;`,
      [fixture.seed.orgId, hotelBId],
    );
    const outboxId = rows[0]!.id;

    const res = await fixture.app.request(`/admin/outbox/${outboxId}/reintentar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const { rows: despues } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.outbox where id = $1;",
      [outboxId],
    );
    expect(despues[0]!.status).toBe("pendiente");

    const auditoria = await fixture.app.request("/admin/auditoria", { headers: { authorization: `Bearer ${token}` } });
    expect(auditoria.status).toBe(200);
    const entradas = (await auditoria.json()) as { action: string }[];
    expect(entradas.some((e) => e.action === "admin_reintentar_outbox")).toBe(true);
    expect(entradas.some((e) => e.action === "admin_negocio")).toBe(true);
  });

  it("reintentar un outbox inexistente responde 404, no 500", async () => {
    const token = await loginAs(fixture.app, ownerHotelAEmail);
    const res = await fixture.app.request(`/admin/outbox/${randomUUID()}/reintentar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
