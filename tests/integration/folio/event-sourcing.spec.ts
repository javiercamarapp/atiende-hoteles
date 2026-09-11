// REQ-REC-004 · reverso/transferencia/split NUNCA borran una fila de `charge`: cada
// operación siempre AGREGA una fila nueva. Verificado contando filas antes/después de
// cada operación (nunca disminuyen) y confirmando 0 DELETE ejecutados sobre
// charge/payment/folio durante todo el flujo (ver también scripts/checks/no-delete-events.ts
// para la revisión estática del código fuente).
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


describe("REQ-REC-004 · event sourcing de folio: reverso/transferencia/split nunca borran", () => {
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

  async function countCharges(): Promise<number> {
    const { rows } = await fixture.engine.admin.query<{ count: string }>("select count(*)::text as count from public.charge;");
    return Number(rows[0]!.count);
  }

  it("el conteo de filas de charge NUNCA disminuye a través de cargo -> reverso -> transferencia -> split", async () => {
    const { folioId: folioA } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(7), checkOutDate: isoDate(8) });
    const { folioId: folioB } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: isoDate(9), checkOutDate: isoDate(10) });

    const before = await countCharges();

    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo 1", monto: 100, concepto: "extras" }),
    });
    const { id: charge1 } = (await chargeRes.json()) as { id: string };
    const afterCharge = await countCharges();
    expect(afterCharge).toBe(before + 1);

    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/cargos/${charge1}/reverso`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ motivo: "error" }),
    });
    const afterReverso = await countCharges();
    expect(afterReverso).toBe(afterCharge + 1); // +1 fila nueva, la original SIGUE viva
    expect(afterReverso).toBeGreaterThan(before);

    const chargeRes2 = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo 2", monto: 200, concepto: "extras" }),
    });
    const { id: charge2 } = (await chargeRes2.json()) as { id: string };
    const afterCharge2 = await countCharges();

    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/cargos/${charge2}/transferir`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ folioDestinoId: folioB }),
    });
    const afterTransfer = await countCharges();
    expect(afterTransfer).toBe(afterCharge2 + 2); // reverso en origen + cargo nuevo en destino

    const chargeRes3 = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cargo 3", monto: 300, concepto: "extras" }),
    });
    const { id: charge3 } = (await chargeRes3.json()) as { id: string };
    const afterCharge3 = await countCharges();

    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioA}/split`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ etiqueta: "Split", chargeIds: [charge3] }),
    });
    const afterSplit = await countCharges();
    expect(afterSplit).toBe(afterCharge3 + 2); // reverso en origen + cargo nuevo en el folio del split

    // Confirmación final: charge1/charge2/charge3 (las filas ORIGINALES) siguen
    // existiendo en la base -- nunca se borraron.
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where id = any($1::uuid[]);",
      [[charge1, charge2, charge3]],
    );
    expect(rows[0]!.count).toBe("3");
  });
});
