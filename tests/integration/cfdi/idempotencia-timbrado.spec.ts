// REQ-BO-002 · timbrar el mismo folio dos veces devuelve el mismo UUID -- verificado
// con 2 llamadas idempotentes consecutivas (misma Idempotency-Key y también con una
// DISTINTA) y con 2 llamadas concurrentes reales (embedded-postgres).
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


describe("REQ-BO-002 · idempotencia de timbrado CFDI", () => {
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

  async function folioConCargo(checkIn: string, checkOut: string) {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: checkIn, checkOutDate: checkOut });
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }),
    });
    return folioId;
  }

  it("misma Idempotency-Key repetida devuelve exactamente la misma respuesta (mismo UUID)", async () => {
    const folioId = await folioConCargo(isoDate(7), isoDate(8));
    const key = randomUUID();
    const opts = {
      method: "POST" as const,
      headers: { ...auth(), "idempotency-key": key },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    };
    const first = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, opts);
    const second = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, opts);
    expect(first.status).toBe(201);
    // La segunda solicitud encuentra el CFDI ya emitido para este folio (200, "ya
    // existe") -- nunca vuelve a llamar al PAC ni crea una segunda fila.
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { uuidFiscal: string };
    const secondBody = (await second.json()) as { uuidFiscal: string };
    expect(secondBody.uuidFiscal).toBe(firstBody.uuidFiscal);
  });

  it("una SEGUNDA solicitud con Idempotency-Key DISTINTA sobre el MISMO folio también devuelve el mismo UUID (nunca dos timbrados)", async () => {
    const folioId = await folioConCargo(isoDate(9), isoDate(10));
    const first = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    const second = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    expect(second.status).toBe(200); // devuelto directo, sin volver a timbrar
    const firstBody = (await first.json()) as { uuidFiscal: string };
    const secondBody = (await second.json()) as { uuidFiscal: string };
    expect(secondBody.uuidFiscal).toBe(firstBody.uuidFiscal);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.cfdi_emision where folio_id = $1;",
      [folioId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("dos solicitudes de timbrado CONCURRENTES sobre el mismo folio: exactamente 1 fila en cfdi_emision", async () => {
    const folioId = await folioConCargo(isoDate(11), isoDate(12));
    const [a, b] = await Promise.all([
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
        method: "POST",
        headers: { ...auth(), "idempotency-key": randomUUID() },
        body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
      }),
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
        method: "POST",
        headers: { ...auth(), "idempotency-key": randomUUID() },
        body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
      }),
    ]);
    // Ambas responden 2xx (una crea, la otra encuentra la que la primera ya insertó
    // vía el índice único parcial `cfdi_emision_folio_hospedaje_unq`) -- lo que importa
    // es que NUNCA queden dos filas ni dos UUID distintos para el mismo folio.
    expect(a.status).toBeGreaterThanOrEqual(200);
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeGreaterThanOrEqual(200);
    expect(b.status).toBeLessThan(300);

    const aBody = (await a.json()) as { uuidFiscal: string };
    const bBody = (await b.json()) as { uuidFiscal: string };
    expect(aBody.uuidFiscal).toBe(bBody.uuidFiscal);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.cfdi_emision where folio_id = $1;",
      [folioId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("cancelar un CFDI ya cancelado se rechaza explícitamente (nunca se re-envía la cancelación al PAC en silencio)", async () => {
    const folioId = await folioConCargo(isoDate(13), isoDate(14));
    const emitRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    const { id: cfdiId } = (await emitRes.json()) as { id: string };

    const first = await fixture.app.request(`/hoteles/${hotelId}/cfdi/${cfdiId}/cancelar`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "02" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { estado: string };
    expect(firstBody.estado).toBe("cancelado");

    const second = await fixture.app.request(`/hoteles/${hotelId}/cfdi/${cfdiId}/cancelar`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "02" }),
    });
    expect(second.status).toBe(409);
  });
});
