// H5 · REQ-BO-001/REQ-REC-004/REQ-REC-012 estilo: cargos por concepto, descuento con
// umbral de autorización, reverso (nunca borrado) y saldo exacto -- todo vía la API
// real, embedded-postgres.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("folio: cargos por concepto, descuentos, reverso (H5)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let gmUserId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    gmUserId = hotelA.staff.find((s) => s.role === "gm")!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("cargo de concepto 'ab' calcula impuesto determinista desde el motor (sin impuesto explícito)", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-16",
      checkOutDate: "2026-09-17",
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Desayuno buffet", monto: 200, concepto: "ab" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { impuesto: number };
    // ivaRate 0.16 + ishRate 0.03 sobre 200 = 38.
    expect(body.impuesto).toBe(38);
  });

  it("descuento bajo el umbral lo aplica frontdesk directamente", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-18",
      checkOutDate: "2026-09-19",
    });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Extra", monto: 1000, concepto: "extras" }),
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cortesía menor", monto: 100 }),
    });
    expect(res.status).toBe(201);
  });

  it("descuento sobre el umbral aplicado por frontdesk SIN autorización se rechaza (403)", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-20",
      checkOutDate: "2026-09-21",
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Descuento grande", monto: 800 }),
    });
    expect(res.status).toBe(403);
  });

  it("descuento sobre el umbral aplicado por frontdesk CON autorización de un gm real se permite", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-22",
      checkOutDate: "2026-09-23",
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Descuento autorizado", monto: 800, autorizadoPorUserId: gmUserId }),
    });
    expect(res.status).toBe(201);
  });

  it("reverso de un cargo NUNCA borra la fila original: inserta una nueva y el saldo vuelve a 0", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-24",
      checkOutDate: "2026-09-25",
    });

    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo erróneo", monto: 500, concepto: "extras" }),
    });
    const { id: chargeId } = (await chargeRes.json()) as { id: string };

    const before = await fixture.engine.admin.query<{ count: string }>("select count(*)::text as count from public.charge where folio_id = $1;", [folioId]);
    expect(before.rows[0]!.count).toBe("1");

    const reversalRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos/${chargeId}/reverso`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "Cargo capturado por error" }),
    });
    expect(reversalRes.status).toBe(201);

    // NUNCA borrado: sigue habiendo 2 filas (original + reverso), nunca 1.
    const after = await fixture.engine.admin.query<{ count: string }>("select count(*)::text as count from public.charge where folio_id = $1;", [folioId]);
    expect(after.rows[0]!.count).toBe("2");

    const { rows: originalRows } = await fixture.engine.admin.query<{ reversed_by: string | null }>(
      "select reversed_by from public.charge where id = $1;",
      [chargeId],
    );
    expect(originalRows[0]!.reversed_by).not.toBeNull();

    const folioGet = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth(gmToken) });
    const folioBody = (await folioGet.json()) as { saldo: number };
    expect(folioBody.saldo).toBe(0);
  });

  it("reversar un cargo ya reversado se rechaza (409)", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-26",
      checkOutDate: "2026-09-27",
    });
    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo X", monto: 100, concepto: "extras" }),
    });
    const { id: chargeId } = (await chargeRes.json()) as { id: string };

    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos/${chargeId}/reverso`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "primero" }),
    });
    const second = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos/${chargeId}/reverso`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "segundo" }),
    });
    expect(second.status).toBe(409);
  });

  it("un folio cerrado no admite nuevos cargos", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: "2026-09-28",
      checkOutDate: "2026-09-29",
    });

    const close = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cerrar`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ motivo: "saldo_cero" }),
    });
    expect(close.status).toBe(200);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Tarde", monto: 50, concepto: "extras" }),
    });
    expect(res.status).toBe(409);
  });
});
