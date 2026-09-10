// REQ-BO-001/H16-007 · CFDI 4.0 de hospedaje al checkout: RFC genérico extranjero
// XEXX010101000/uso S01, factura global de público en general, ISH/DSA en
// `ImpuestosLocales` fuera de la base de IVA, propina excluida, no-show como concepto
// de hospedaje, y relación tipo 07 (anticipo) registrada -- 7 casos, vía la API real
// con el `CfdiPort` simulado (DualPacCfdiPort + fakes, ver apps/api/src/app.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../../support/api-fixture.ts";

/** Fechas relativas a "hoy" -- nunca un string absoluto, para que la suite no se
 *  pudra cuando el reloj real cruce la fecha hardcodeada (visto en CI: un
 *  checkInDate fijo en el pasado ya no tiene tarifa configurada). */
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe("REQ-BO-001 · contrato de CFDI de hospedaje (7 casos)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  let diaSecuencial = 10;
  async function folioConCargo(monto: number, concepto = "hospedaje") {
    diaSecuencial += 1;
    const checkIn = isoDate(diaSecuencial);
    const checkOut = isoDate(diaSecuencial + 1);
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn,
      checkOutDate: checkOut,
    });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Hospedaje", monto, concepto }),
    });
    return folioId;
  }

  it("1) huésped extranjero: RFC genérico XEXX010101000 y uso CFDI S01, sin importar lo que el body pida", async () => {
    const folioId = await folioConCargo(1000);
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esExtranjero: true, rfcReceptor: "IGNORADO0000", usoCfdi: "G01", metodoPago: "PUE" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; uuidFiscal: string; estado: string };
    expect(body.estado).toBe("timbrado");
    expect(body.uuidFiscal).toBeTruthy();

    const { rows } = await fixture.engine.admin.query<{ rfc_receptor: string; uso_cfdi: string }>(
      "select rfc_receptor, uso_cfdi from public.cfdi_emision where id = $1;",
      [body.id],
    );
    expect(rows[0]!.rfc_receptor).toBe("XEXX010101000");
    expect(rows[0]!.uso_cfdi).toBe("S01");
  });

  it("2) factura global de público en general: RFC XAXX010101000", async () => {
    const folioId = await folioConCargo(1000);
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const { rows } = await fixture.engine.admin.query<{ rfc_receptor: string }>(
      "select rfc_receptor from public.cfdi_emision where id = $1;",
      [body.id],
    );
    expect(rows[0]!.rfc_receptor).toBe("XAXX010101000");
  });

  it("3) complemento ImpuestosLocales lleva ISH fuera de la base de IVA (subtotal/IVA no incluyen ISH)", async () => {
    const folioId = await folioConCargo(1000);
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    const body = (await res.json()) as { id: string };
    const { rows } = await fixture.engine.admin.query<{ subtotal: string; iva: string; impuestos_locales: { ishMonto: number } }>(
      "select subtotal::text as subtotal, iva::text as iva, impuestos_locales from public.cfdi_emision where id = $1;",
      [body.id],
    );
    expect(Number(rows[0]!.subtotal)).toBe(1000);
    expect(Number(rows[0]!.iva)).toBe(160); // 16% de 1000, sin ISH mezclado
    expect(rows[0]!.impuestos_locales.ishMonto).toBe(30); // 3% de 1000, aparte
  });

  it("4) propina NUNCA entra al subtotal del CFDI", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDate(6),
      checkOutDate: isoDate(7),
    });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }),
    });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Propina camarista", monto: 200, concepto: "propina" }),
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    const body = (await res.json()) as { id: string };
    const { rows } = await fixture.engine.admin.query<{ subtotal: string }>(
      "select subtotal::text as subtotal from public.cfdi_emision where id = $1;",
      [body.id],
    );
    expect(Number(rows[0]!.subtotal)).toBe(1000); // los 200 de propina no aparecen
  });

  it("5) no-show: la penalización se postea como concepto 'hospedaje', lleva IVA pero NO ISH, y el CFDI declara EXACTAMENTE lo que el folio le cobró al huésped (F3)", async () => {
    const { reservationId, folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDate(1),
      checkOutDate: isoDate(2),
    });
    await fixture.app.request(`/hoteles/${hotelId}/reservas/procesar-no-show`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ asOfDate: isoDate(4) }),
    });
    const { rows: reservationRows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [reservationId],
    );
    expect(reservationRows[0]!.status).toBe("no_show");

    // El folio ya le cobró al huésped monto+impuesto del cargo de penalidad -- el
    // saldo del folio es la ÚNICA fuente de verdad de cuánto se le cobró de verdad.
    const folioAntes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth() });
    const folioBody = (await folioAntes.json()) as { cargos: Array<{ monto: number; impuesto: number; descripcion: string }> };
    const cargoPenalidad = folioBody.cargos.find((c) => c.descripcion === "Penalización por no-show")!;
    expect(cargoPenalidad).toBeDefined();
    // H16 p.14: IVA sí (pena convencional gravada), ISH no (no hubo hospedaje real).
    expect(cargoPenalidad.impuesto).toBe(Math.round(cargoPenalidad.monto * 0.16 * 100) / 100);
    const folioTotalCobrado = cargoPenalidad.monto + cargoPenalidad.impuesto;

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, esNoShow: true, metodoPago: "PUE" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; total: number };
    const { rows } = await fixture.engine.admin.query<{ subtotal: string; iva: string; impuestos_locales: { ishMonto: number }; total: string }>(
      "select subtotal::text as subtotal, iva::text as iva, impuestos_locales, total::text as total from public.cfdi_emision where id = $1;",
      [body.id],
    );
    expect(Number(rows[0]!.subtotal)).toBeGreaterThan(0);
    expect(rows[0]!.impuestos_locales.ishMonto).toBe(0); // sin ISH en la penalidad
    // El total del CFDI coincide EXACTO con lo que el folio le cobró al huésped --
    // ninguna segunda fuente de cálculo que pueda divergir (F3).
    expect(Number(rows[0]!.total)).toBe(folioTotalCobrado);
    expect(body.total).toBe(folioTotalCobrado);
  });

  it("6) anticipo: un CFDI puede relacionarse con uno previo (tipo de relación 07, registrado en related_cfdi_id)", async () => {
    const folioAnticipo = await folioConCargo(300);
    const anticipoRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioAnticipo}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    const anticipoBody = (await anticipoRes.json()) as { id: string };

    const folioFinal = await folioConCargo(1000);
    const finalRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioFinal}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE", relacionadoCfdiId: anticipoBody.id }),
    });
    const finalBody = (await finalRes.json()) as { id: string };
    const { rows } = await fixture.engine.admin.query<{ related_cfdi_id: string }>(
      "select related_cfdi_id from public.cfdi_emision where id = $1;",
      [finalBody.id],
    );
    expect(rows[0]!.related_cfdi_id).toBe(anticipoBody.id);
  });

  it("7) rfcReceptor/usoCfdi son obligatorios cuando NO es extranjero ni global", async () => {
    const folioId = await folioConCargo(1000);
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ metodoPago: "PUE" }),
    });
    expect(res.status).toBe(400);
  });
});
