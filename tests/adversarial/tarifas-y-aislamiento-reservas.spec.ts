// H4 · Dos afirmaciones adversariales pedidas explícitamente por el encargo:
//  1) recepción (frontdesk) NO puede cambiar tarifas — solo owner/gm/reservations
//     (`MANAGE_INVENTORY_ROLES`, mismos roles que ya podían escribir `rate_plan` en la
//     RLS de 0004; aquí se verifica también la capa de aplicación de routes/tarifas.ts).
//  2) un hotel B no puede ver las reservas de un hotel A: la ruta real de este
//     repositorio para reservas es `/hoteles/:hotelId/reservas` (nunca
//     `/reservations?hotel=`, que no existe aquí) — se verifica el equivalente real:
//     staff de B pidiendo `/hoteles/<A>/reservas` recibe 403 y ninguna fila.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: tarifas restringidas por rol + aislamiento de reservas entre hoteles", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("frontdesk (recepción) NO puede modificar una tarifa (403), gm SÍ puede", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const roomTypeId = hotelA.roomTypes[0]!.id;
    const frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const body = { roomTypeId, desde: "2026-12-01", hasta: "2026-12-05", price: 3000 };

    const rechazo = await fixture.app.request(`/hoteles/${hotelA.id}/tarifas`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(rechazo.status).toBe(403);

    const permitido = await fixture.app.request(`/hoteles/${hotelA.id}/tarifas`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(permitido.status).toBe(200);
  });

  it("frontdesk NO puede cambiar impuestos (IVA/ISH) ni la política de cancelación del hotel (403)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const impuestos = await fixture.app.request(`/hoteles/${hotelA.id}/impuestos`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ivaRate: 0.16, ishRate: 0.05 }),
    });
    expect(impuestos.status).toBe(403);

    const politica = await fixture.app.request(`/hoteles/${hotelA.id}/politica-cancelacion`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ freeUntilHours: 0, penaltyPct: 100, noShowPct: 100, depositPct: 0 }),
    });
    expect(politica.status).toBe(403);
  });

  it("staff de hotel B NO puede leer las reservas de hotel A (403, ninguna fila expuesta)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmB = hotelB.staff.find((s) => s.role === "gm")!;
    const tokenB = await loginAs(fixture.app, gmB.email);

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/reservas`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  it("staff de hotel B tampoco puede leer una reserva puntual de hotel A por id (403)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const tokenA = await loginAs(fixture.app, gmA.email);

    const creada = await fixture.app.request(`/hoteles/${hotelA.id}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: "2026-09-10",
        checkOutDate: "2026-09-11",
      }),
    });
    const { id: reservationId } = (await creada.json()) as { id: string };

    const tokenB = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
    const res = await fixture.app.request(`/hoteles/${hotelA.id}/reservas/${reservationId}`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(403);
  });
});
