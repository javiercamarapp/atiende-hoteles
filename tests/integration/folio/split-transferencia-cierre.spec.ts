// H5 · split de folio, transferir cargo entre folios del mismo hotel, y cierre
// (saldo cero o cuenta por cobrar autorizada) -- todo vía la API real.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


describe("folio: split, transferencia entre folios, cierre (H5)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let hotelBId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    hotelId = hotelA.id;
    hotelBId = hotelB.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  it("split: mueve un cargo a un folio nuevo de la MISMA reserva, ambos saldos cuadran", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(7), checkOutDate: isoDate(8) });
    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Minibar", monto: 300, concepto: "extras" }),
    });
    const { id: chargeId } = (await chargeRes.json()) as { id: string };

    const splitRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/split`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ etiqueta: "Gastos personales", chargeIds: [chargeId] }),
    });
    expect(splitRes.status).toBe(201);
    const { id: newFolioId } = (await splitRes.json()) as { id: string };

    const folioGet = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth() });
    const { reservationId } = (await folioGet.json()) as { reservationId: string };
    const listRes = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/folios`, { headers: auth() });
    expect(listRes.status).toBe(200);
    const folios = (await listRes.json()) as { id: string; esPrincipal: boolean; saldo: number }[];
    expect(folios).toHaveLength(2);
    const original = folios.find((f) => f.id === folioId)!;
    const nuevo = folios.find((f) => f.id === newFolioId)!;
    expect(original.saldo).toBe(0); // el cargo se fue
    expect(nuevo.saldo).toBe(348); // 300 + 16% IVA (sin ISH, H16-010: "extras" no lleva ISH)
    expect(nuevo.esPrincipal).toBe(false);
  });

  it("transferir un cargo a otro folio EXISTENTE del mismo hotel: saldo se mueve", async () => {
    const { folioId: folioOrigen } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(9), checkOutDate: isoDate(10) });
    const { folioId: folioDestino } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(11), checkOutDate: isoDate(12) });

    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioOrigen}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Spa", monto: 400, concepto: "extras" }),
    });
    const { id: chargeId } = (await chargeRes.json()) as { id: string };

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioOrigen}/cargos/${chargeId}/transferir`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ folioDestinoId: folioDestino, motivo: "Cargo del acompañante" }),
    });
    expect(res.status).toBe(201);

    const origenGet = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioOrigen}`, { headers: auth() });
    const destinoGet = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioDestino}`, { headers: auth() });
    expect(((await origenGet.json()) as { saldo: number }).saldo).toBe(0);
    expect(((await destinoGet.json()) as { saldo: number }).saldo).toBe(464); // 400 + 16% IVA (sin ISH)
  });

  it("no se puede transferir un cargo a un folio de OTRO hotel", async () => {
    const { folioId: folioOrigen } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(13), checkOutDate: isoDate(14) });
    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioOrigen}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo", monto: 100, concepto: "extras" }),
    });
    const { id: chargeId } = (await chargeRes.json()) as { id: string };

    const { rows: otroHotelFolio } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.folio where hotel_id = $1 limit 1;",
      [hotelBId],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioOrigen}/cargos/${chargeId}/transferir`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ folioDestinoId: otroHotelFolio[0]?.id ?? randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("cierre con saldo distinto de cero como saldo_cero se rechaza (409)", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(15), checkOutDate: isoDate(16) });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo", monto: 500, concepto: "extras" }),
    });
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cerrar`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ motivo: "saldo_cero" }),
    });
    expect(res.status).toBe(409);
  });

  it("cierre como cuenta_por_cobrar con saldo pendiente y rol administrativo se permite", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(17), checkOutDate: isoDate(18) });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo", monto: 500, concepto: "extras" }),
    });
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cerrar`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ motivo: "cuenta_por_cobrar" }),
    });
    expect(res.status).toBe(200);

    const { rows } = await fixture.engine.admin.query<{ status: string; ar_approved_by: string | null }>(
      "select status, ar_approved_by from public.folio where id = $1;",
      [folioId],
    );
    expect(rows[0]!.status).toBe("cerrado");
    expect(rows[0]!.ar_approved_by).not.toBeNull();
  });
});
