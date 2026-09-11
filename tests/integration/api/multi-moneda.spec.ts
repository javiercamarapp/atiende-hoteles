// REQ-RES-015: hasta este cableado, `packages/domain-hotel/src/reservas/multiMoneda.ts`
// (`resolveVigenteExchangeRate`/`convertToReportingCurrency`/`summarizeMultiCurrencyTotals`)
// y la tabla `hotel_exchange_rate` (migración 0130) existían y estaban probados en
// aislamiento (tests/unit/domain-hotel/multi-moneda.spec.ts), pero NINGUNA ruta HTTP los
// invocaba: no había endpoint para que un hotel registrara su tipo de cambio, y
// `routes/quotes.ts`/`routes/reservas.ts` trataban `rate_plan.currency`/`reservation.currency`
// como texto plano sin ninguna conversión real -- el motor de reservas operaba igual que
// si el módulo nunca hubiera existido. Esta suite prueba el camino de ejecución REAL
// contra Postgres embebido (nunca mockeado): registrar el tipo de cambio vía la API,
// cotizar/reservar una tarifa fijada en USD y ver la conversión reflejada de verdad en la
// respuesta -- y el caso negativo (sin tasa vigente configurada, la reserva NUNCA se crea
// con un monto en la moneda equivocada).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

// Mismo criterio que tests/integration/api/reservas-y-folios.spec.ts: offsets relativos
// a "hoy" (la seed solo cubre tarifa/disponibilidad 30 días hacia adelante), nunca
// literales absolutos.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe("REQ-RES-015: multi-moneda cableado end-to-end (integración real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let orgId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    orgId = fixture.seed.orgId;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  /** Sobrescribe (sin cambiar el esquema) la tarifa YA sembrada por seedDev para una
   *  fecha concreta con una tarifa fijada en `currency` -- mismo `on conflict` que usa
   *  `PUT /hoteles/:hotelId/tarifas` (routes/tarifas.ts), directo contra el cliente
   *  admin porque esta suite necesita fijar la MONEDA de la tarifa, campo que esa ruta
   *  todavía no expone en su body. */
  async function setForeignRate(
    targetRoomTypeId: string,
    date: string,
    currency: string,
    price: number,
  ): Promise<void> {
    await fixture.engine.admin.query(
      `insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price, currency)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (room_type_id, date) do update set price = excluded.price, currency = excluded.currency;`,
      [orgId, hotelId, targetRoomTypeId, date, price, currency],
    );
  }

  async function setUsdRate(date: string, priceUsd: number): Promise<void> {
    await setForeignRate(roomTypeId, date, "USD", priceUsd);
  }

  describe("POST/GET /hoteles/:hotelId/tipo-cambio (endpoint faltante para registrar la tasa vigente)", () => {
    it("GET sin ninguna fila registrada devuelve lista vacía (seedDev no siembra hotel_exchange_rate)", async () => {
      const res = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, { headers: auth(gmToken) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("frontdesk (rol con acceso a dinero pero sin ADMIN_ROLES) NO puede registrar una tasa -- 403", async () => {
      const res = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ fromCurrency: "USD", toCurrency: "MXN", rate: 18.5, effectiveDate: isoDate(0) }),
      });
      expect(res.status).toBe(403);
    });

    it("owner/gm SÍ puede registrar una tasa real -- persiste en hotel_exchange_rate y queda auditada", async () => {
      const res = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ fromCurrency: "usd", toCurrency: "mxn", rate: 18.5, effectiveDate: isoDate(0) }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; fromCurrency: string; toCurrency: string; rate: number; effectiveDate: string };
      expect(body.fromCurrency).toBe("USD"); // normalizado a mayúsculas por el schema
      expect(body.toCurrency).toBe("MXN");
      expect(body.rate).toBe(18.5);

      const { rows } = await fixture.engine.admin.query<{ rate: string }>(
        "select rate from public.hotel_exchange_rate where id = $1;",
        [body.id],
      );
      expect(Number(rows[0]!.rate)).toBe(18.5);

      const { rows: auditRows } = await fixture.engine.admin.query<{ action: string }>(
        "select action from public.audit_log where entity_id = $1;",
        [body.id],
      );
      expect(auditRows.some((r) => r.action === "hotel_exchange_rate.created")).toBe(true);

      const list = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, { headers: auth(gmToken) });
      const listBody = (await list.json()) as unknown[];
      expect(listBody).toHaveLength(1);
    });

    it("append-only: registrar la MISMA fecha/par otra vez responde 409, nunca sobreescribe (la tabla no tiene policy de UPDATE)", async () => {
      const res = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ fromCurrency: "USD", toCurrency: "MXN", rate: 19.0, effectiveDate: isoDate(0) }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("tipo_cambio_ya_registrado");
    });
  });

  describe("POST /hoteles/:hotelId/quotes con una tarifa fijada en USD (conversión activa a MXN)", () => {
    it("caso negativo: sin tasa vigente para la fecha consultada, la cotización falla explícito (fail-closed), nunca inventa un total", async () => {
      // EUR (nunca USD): esta suite SÍ registra tasas USD->MXN en otros tests de este
      // mismo archivo (mismo hotel) -- usar un par de divisas que jamás se registra en
      // ningún otro test hace esta prueba independiente del orden de ejecución, en vez
      // de depender de que ninguna fecha futura quede "vigente" por accidente.
      const checkIn = isoDate(1);
      const checkOut = isoDate(2);
      await setForeignRate(roomTypeId, checkIn, "EUR", 100);
      await setForeignRate(roomTypeId, checkOut, "EUR", 100);

      const res = await fixture.app.request(`/hoteles/${hotelId}/quotes`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("tipo_cambio_no_registrado");
      expect(body.message).toMatch(/EUR/);
    });

    it("con tasa vigente registrada, la cotización convierte ACTIVAMENTE de USD a MXN usando la tasa real", async () => {
      const checkIn = isoDate(5);
      const checkOut = isoDate(6);
      await setUsdRate(checkIn, 100);
      await setUsdRate(checkOut, 100);

      const rateRes = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ fromCurrency: "USD", toCurrency: "MXN", rate: 18.5, effectiveDate: checkIn }),
      });
      expect(rateRes.status).toBe(201);

      const res = await fixture.app.request(`/hoteles/${hotelId}/quotes`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        currency: string;
        netAmount: number;
        monedaOriginal: string;
        montoOriginal: number;
        tipoCambioAplicado: number | null;
      };
      expect(body.currency).toBe("MXN");
      expect(body.netAmount).toBe(1850); // 100 USD * 18.5
      expect(body.monedaOriginal).toBe("USD");
      // montoOriginal es el TOTAL original (neto + IVA 16% + ISH 3%, ver seedDev), no
      // solo el neto: 100 * 1.19 = 119, en USD, sin convertir.
      expect(body.montoOriginal).toBe(119);
      expect(body.tipoCambioAplicado).toBe(18.5);
    });
  });

  describe("POST /hoteles/:hotelId/reservas con tarifa en USD (el motor de reservas OPERA en multi-moneda, no solo el módulo aislado)", () => {
    it("crea una reserva real con total convertido y persistido en MXN, trazable hasta el tipo de cambio aplicado", async () => {
      const checkIn = isoDate(8);
      const checkOut = isoDate(10); // 2 noches
      await setUsdRate(checkIn, 100);
      await setUsdRate(isoDate(9), 100);
      await setUsdRate(checkOut, 100);

      const rateRes = await fixture.app.request(`/hoteles/${hotelId}/tipo-cambio`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ fromCurrency: "USD", toCurrency: "MXN", rate: 18.5, effectiveDate: checkIn }),
      });
      expect(rateRes.status).toBe(201);

      const key = randomUUID();
      const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": key },
        body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        total: number;
        moneda: string;
        conversion: { monedaOriginal: string; montoOriginal: number; monedaReporte: string; tipoCambioAplicado: number } | null;
      };
      expect(created.moneda).toBe("MXN");
      expect(created.total).toBe(3700); // 2 noches * 100 USD * 18.5
      expect(created.conversion).not.toBeNull();
      expect(created.conversion!.monedaOriginal).toBe("USD");
      expect(created.conversion!.montoOriginal).toBe(200); // 2 * 100 USD, sin convertir
      expect(created.conversion!.tipoCambioAplicado).toBe(18.5);

      // La conversión REALMENTE se persistió -- total_amount en la fila real de
      // `reservation` ya está en MXN (nunca 200, el monto crudo en USD sin convertir).
      const { rows } = await fixture.engine.admin.query<{ total_amount: string; currency: string }>(
        "select total_amount, currency from public.reservation where id = $1;",
        [created.id],
      );
      expect(Number(rows[0]!.total_amount)).toBe(3700);
      expect(rows[0]!.currency).toBe("MXN");

      // Rastro auditable real: el audit_log y el outbox del evento reservation.created
      // dejan la conversión aplicada, no solo el total ya convertido.
      const { rows: auditRows } = await fixture.engine.admin.query<{ payload: { conversion?: { tipoCambioAplicado: number } } }>(
        "select payload from public.audit_log where entity_id = $1 and action = 'reservation.created';",
        [created.id],
      );
      expect(auditRows[0]!.payload.conversion?.tipoCambioAplicado).toBe(18.5);

      const { rows: outboxRows } = await fixture.engine.admin.query<{ payload: { conversion?: { tipoCambioAplicado: number } } }>(
        "select payload from public.outbox where aggregate_id = $1 and event_type = 'reservation.created';",
        [created.id],
      );
      expect(outboxRows[0]!.payload.conversion?.tipoCambioAplicado).toBe(18.5);
    });

    it("caso negativo: reservar una tarifa en una divisa SIN tasa vigente configurada falla explícito (409) -- nunca crea la reserva con un monto en la moneda equivocada", async () => {
      // EUR, por la misma razón que el caso negativo de /quotes arriba: nunca se
      // registra un tipo de cambio EUR->MXN en ningún otro test de este archivo, así
      // que esta prueba no depende de qué otros tests ya corrieron antes.
      const checkIn = isoDate(14);
      const checkOut = isoDate(15);
      await setForeignRate(roomTypeId, checkIn, "EUR", 100);
      await setForeignRate(roomTypeId, checkOut, "EUR", 100);

      const key = randomUUID();
      const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": key },
        body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("tipo_cambio_no_registrado");

      // Fail-closed de verdad: ninguna fila quedó insertada para este idempotency-key.
      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.reservation where idempotency_key = $1;",
        [key],
      );
      expect(rows[0]!.count).toBe("0");
    });

    it("dos monedas activas en el mismo periodo: una reserva en MXN y otra en USD conviven, y el listado refleja ambas ya convertidas a MXN de forma consistente", async () => {
      // Reserva en MXN (tarifa MXN por defecto, sembrada por seedDev, sin tocar).
      const mxnCheckIn = isoDate(20);
      const mxnCheckOut = isoDate(21);
      const mxnRes = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
        body: JSON.stringify({ roomTypeId, checkInDate: mxnCheckIn, checkOutDate: mxnCheckOut }),
      });
      expect(mxnRes.status).toBe(201);
      const mxnCreated = (await mxnRes.json()) as { id: string; total: number; moneda: string; conversion: unknown };
      expect(mxnCreated.moneda).toBe("MXN");
      expect(mxnCreated.conversion).toBeNull(); // sin conversión: ya estaba en la moneda de reporte

      // Reserva en USD, mismo periodo (misma ventana de fechas), tasa vigente ya
      // registrada arriba (effectiveDate = isoDate(8), <= isoDate(20)).
      const usdCheckIn = isoDate(20);
      const usdRoomTypeId = fixture.seed.hotels[0]!.roomTypes[1]!.id; // Suite: tipo distinto para no chocar disponibilidad con la reserva MXN de arriba
      // Ambas fechas del rango consultado [checkIn, checkOut] INCLUSIVE (ver
      // pms/dbRoomRatePort.ts) deben quedar en USD -- dejar la fila de checkout en MXN
      // (la que sembró seedDev sin tocar) produciría una estadía con DOS monedas
      // mezcladas entre noches (409 moneda_mixta_no_soportada), no lo que esta prueba
      // quiere ejercitar.
      await setForeignRate(usdRoomTypeId, usdCheckIn, "USD", 50);
      await setForeignRate(usdRoomTypeId, mxnCheckOut, "USD", 50);
      const usdRes = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
        body: JSON.stringify({ roomTypeId: usdRoomTypeId, checkInDate: usdCheckIn, checkOutDate: mxnCheckOut }),
      });
      expect(usdRes.status).toBe(201);
      const usdCreated = (await usdRes.json()) as { id: string; total: number; moneda: string; conversion: { tipoCambioAplicado: number } | null };
      expect(usdCreated.moneda).toBe("MXN");
      expect(usdCreated.total).toBe(50 * 18.5);
      expect(usdCreated.conversion?.tipoCambioAplicado).toBe(18.5);

      // GET /reservas: ambas reservas del mismo periodo aparecen con un total
      // homogéneo en MXN -- la de origen USD YA viene convertida, no como 50 "MXN".
      const list = await fixture.app.request(`/hoteles/${hotelId}/reservas`, { headers: auth(gmToken) });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { id: string; total: number }[];
      const mxnRow = listBody.find((r) => r.id === mxnCreated.id);
      const usdRow = listBody.find((r) => r.id === usdCreated.id);
      expect(mxnRow?.total).toBe(mxnCreated.total);
      expect(usdRow?.total).toBe(50 * 18.5);
    });
  });
});
