// H5 · pago concurrente con la MISMA Idempotency-Key sobre el mismo folio: exactamente
// UN pago se escribe (nunca doble cobro), verificado con dos requests reales
// disparados en paralelo contra embedded-postgres.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("pago concurrente con la misma Idempotency-Key (H5)", () => {
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

  it("dos solicitudes de pago simultáneas con la MISMA Idempotency-Key -> exactamente 1 fila en payment", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: "2026-09-16", checkOutDate: "2026-09-17" });
    const key = randomUUID();
    const opts = {
      method: "POST" as const,
      headers: { ...auth(), "idempotency-key": key },
      body: JSON.stringify({ monto: 500, metodo: "efectivo" }),
    };

    const [a, b] = await Promise.all([
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, opts),
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, opts),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aBody = (await a.json()) as { id: string };
    const bBody = (await b.json()) as { id: string };
    expect(aBody.id).toBe(bBody.id);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.payment where folio_id = $1;",
      [folioId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("dos solicitudes de pago con tarjeta y la MISMA Idempotency-Key -> PaymentsPort.charge() solo cobra una vez", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: "2026-09-18", checkOutDate: "2026-09-19" });
    const key = randomUUID();
    const opts = {
      method: "POST" as const,
      headers: { ...auth(), "idempotency-key": key },
      body: JSON.stringify({ monto: 800, metodo: "tarjeta", tokenPago: "tok_test_visa_concurrente" }),
    };

    const [a, b] = await Promise.all([
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, opts),
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, opts),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aBody = (await a.json()) as { id: string; estado: string };
    const bBody = (await b.json()) as { id: string };
    expect(aBody.id).toBe(bBody.id);
    expect(aBody.estado).toBe("capturado");

    const { rows: paymentRows } = await fixture.engine.admin.query<{ count: string; external_ref: string }>(
      "select count(*)::text as count, max(external_ref) as external_ref from public.payment where folio_id = $1 group by external_ref;",
      [folioId],
    );
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]!.count).toBe("1");
  });
});
