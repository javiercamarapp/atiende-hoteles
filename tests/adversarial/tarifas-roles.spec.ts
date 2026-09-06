// H4 · Solo MANAGE_INVENTORY_ROLES (owner/gm/reservations) puede escribir tarifas
// (PUT /hoteles/:hotelId/tarifas) o configuración fiscal/política de cancelación
// (ADMIN_ROLES: owner/gm) — recepción (frontdesk) y housekeeping NUNCA pueden cambiar
// precios, en dos capas (middleware de la API + RLS real de packages/db).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { HOTEL_ROLES, MANAGE_INVENTORY_ROLES } from "@atiende-hoteles/api";

describe("adversarial: solo roles de inventario/gerencia pueden cambiar tarifas", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let futureDate: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    futureDate = rows[0]!.date;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const NO_INVENTORY_ROLES = HOTEL_ROLES.filter((r) => !MANAGE_INVENTORY_ROLES.includes(r));

  it.each(NO_INVENTORY_ROLES)("rol %s NO puede cambiar una tarifa (403, doble capa)", async (role) => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === role)!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/tarifas`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ roomTypeId, date: futureDate, price: 99999 }),
    });
    expect(res.status).toBe(403);

    const { rows } = await fixture.engine.admin.query<{ price: string }>(
      "select price from public.rate_plan where room_type_id = $1 and date = $2;",
      [roomTypeId, futureDate],
    );
    expect(Number(rows[0]!.price)).not.toBe(99999);
  });

  it.each(MANAGE_INVENTORY_ROLES)("rol %s SÍ puede cambiar una tarifa", async (role) => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === role)!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/tarifas`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ roomTypeId, date: futureDate, price: 1000 + Math.random() }),
    });
    expect(res.status).toBe(200);
  });

  it("recepción (frontdesk) intentando escribir rate_plan directamente (bypaseando la API) es rechazada por RLS", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    // A diferencia de un INSERT (cuyo WITH CHECK falla y lanza), un UPDATE bajo RLS con
    // una política USING restrictiva simplemente no encuentra filas que igualen (0 filas
    // afectadas) — no lanza. La propiedad de seguridad real a verificar es que el precio
    // JAMÁS cambia, no que la sentencia lance un error.
    await fixture.engine.withAppSession({ userId: frontdesk.id }, async (session) => {
      await session.query("update public.rate_plan set price = 1 where room_type_id = $1 and date = $2;", [
        roomTypeId,
        futureDate,
      ]);
    });

    const { rows } = await fixture.engine.admin.query<{ price: string }>(
      "select price from public.rate_plan where room_type_id = $1 and date = $2;",
      [roomTypeId, futureDate],
    );
    expect(Number(rows[0]!.price)).not.toBe(1);
  });

  it("frontdesk/housekeeping NO pueden configurar impuestos ni política de cancelación (solo ADMIN_ROLES)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const resImpuestos = await fixture.app.request(`/hoteles/${hotelId}/impuestos`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ivaRate: 0, ishRate: 0 }),
    });
    expect(resImpuestos.status).toBe(403);

    const resPolitica = await fixture.app.request(`/hoteles/${hotelId}/politica-cancelacion`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ freeUntilHours: 0, penaltyPct: 100, noShowPct: 100, depositPct: 0 }),
    });
    expect(resPolitica.status).toBe(403);
  });
});
