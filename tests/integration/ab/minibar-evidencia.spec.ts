// REQ-AB-005 (P2/F): "El sistema debe registrar consumo de minibar/honor bar mediante
// foto o checklist con evidencia asociada al cargo, manteniendo la tasa de disputas
// bajo un umbral objetivo (p.ej. <3%)." Prueba REAL contra embedded-postgres (sin
// mocks de base de datos) vía la app Hono real (`tests/support/api-fixture.ts`),
// ejercitando `apps/api/src/routes/minibar.ts`.
//
// Criterio de aceptación (docs/ACEPTACION.md): "Consumo de minibar/honor bar
// registrado con foto o checklist asociado al cargo; tasa de disputas medida bajo el
// umbral objetivo (<3%) en el reporte periódico."
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("REQ-AB-005: consumo de minibar/honor bar con evidencia asociada al cargo, y reporte de tasa de disputas", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let frontdeskToken: string;
  let housekeepingToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  // Cada llamada a `nuevoFolio()` usa un par de fechas DISTINTO (avanzando por el
  // horizonte de disponibilidad sembrado) -- reutilizar siempre las mismas dos fechas
  // agotaría el inventario sembrado (5 habitaciones por tipo) a partir de la 6ta
  // llamada y haría fallar la creación de la reserva con 409 `sin_disponibilidad`,
  // sin relación alguna con lo que esta suite prueba.
  let fechaOffset = 0;

  async function nuevoFolio(): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    const checkIn = rows[fechaOffset]!.date;
    const checkOut = rows[fechaOffset + 1]!.date;
    fechaOffset += 2;
    const { folioId } = await crearFolioConfirmado(fixture.app, frontdeskToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn,
      checkOutDate: checkOut,
    });
    return folioId;
  }

  async function contarCargos(folioId: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.charge where folio_id = $1;",
      [folioId],
    );
    return Number(rows[0]!.n);
  }

  it("registra un consumo de minibar con FOTO de evidencia y crea el cargo real asociado", async () => {
    const folioId = await nuevoFolio();
    const antes = await contarCargos(folioId);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 120, tipoEvidencia: "foto", fotoUrl: "https://cdn.example.com/minibar/1.jpg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chargeId: string; tipoEvidencia: string; fotoUrl: string | null };
    expect(body.tipoEvidencia).toBe("foto");
    expect(body.fotoUrl).toBe("https://cdn.example.com/minibar/1.jpg");

    // Evidencia estructural en la base real: exactamente 1 cargo nuevo en el folio, del
    // concepto 'ab', y la fila de `minibar_consumption` apunta exactamente a ese cargo.
    expect(await contarCargos(folioId)).toBe(antes + 1);
    const { rows } = await fixture.engine.admin.query<{ concept: string; amount: string }>(
      "select concept, amount::text as amount from public.charge where id = $1;",
      [body.chargeId],
    );
    expect(rows[0]!.concept).toBe("ab");
    expect(Number(rows[0]!.amount)).toBeCloseTo(120, 2);
  });

  it("registra un consumo de minibar con CHECKLIST de evidencia", async () => {
    const folioId = await nuevoFolio();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({
        monto: 85,
        tipoEvidencia: "checklist",
        checklistItems: [
          { item: "Cerveza 355ml", cantidad: 2 },
          { item: "Botana salada", cantidad: 1 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { checklist: unknown };
    expect(Array.isArray(body.checklist)).toBe(true);
    expect((body.checklist as unknown[]).length).toBe(2);
  });

  // CASO NEGATIVO central del criterio de aceptación: sin foto NI checklist válido, el
  // sistema NO debe registrar el consumo -- ni el cargo, ni la evidencia.
  it("caso negativo: sin evidencia real (foto vacía) rechaza la solicitud y NO crea ningún cargo", async () => {
    const folioId = await nuevoFolio();
    const antes = await contarCargos(folioId);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 50, tipoEvidencia: "foto", fotoUrl: "" }),
    });
    expect(res.status).toBe(400);

    // Evidencia estructural: 0 cargos nuevos -- el rechazo ocurrió ANTES de cualquier
    // INSERT, nunca queda un cargo huérfano sin su evidencia.
    expect(await contarCargos(folioId)).toBe(antes);
  });

  it("caso negativo: checklist vacío también se rechaza y no crea cargo", async () => {
    const folioId = await nuevoFolio();
    const antes = await contarCargos(folioId);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 50, tipoEvidencia: "checklist", checklistItems: [] }),
    });
    expect(res.status).toBe(400);
    expect(await contarCargos(folioId)).toBe(antes);
  });

  it("housekeeping no puede registrar consumo de minibar (frontera de acceso a dinero, igual que folio/charge)", async () => {
    const folioId = await nuevoFolio();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(housekeepingToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 50, tipoEvidencia: "foto", fotoUrl: "https://cdn.example.com/x.jpg" }),
    });
    expect(res.status).toBe(403);
  });

  it("ciclo de disputa: disputar dos veces el mismo consumo se rechaza (409)", async () => {
    const folioId = await nuevoFolio();
    const creado = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 60, tipoEvidencia: "foto", fotoUrl: "https://cdn.example.com/2.jpg" }),
    });
    const { id: consumptionId } = (await creado.json()) as { id: string };

    const disputa1 = await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/disputa`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "El huésped dice que no consumió nada." }),
    });
    expect(disputa1.status).toBe(200);
    const disputado = (await disputa1.json()) as { disputadoEn: string | null };
    expect(disputado.disputadoEn).not.toBeNull();

    const disputa2 = await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/disputa`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "Segundo intento." }),
    });
    expect(disputa2.status).toBe(409);
  });

  it("resolver una disputa como 'procede' reversa el cargo original (mismo mecanismo que folios.ts)", async () => {
    const folioId = await nuevoFolio();
    const creado = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 40, tipoEvidencia: "foto", fotoUrl: "https://cdn.example.com/3.jpg" }),
    });
    const { id: consumptionId, chargeId } = (await creado.json()) as { id: string; chargeId: string };

    await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/disputa`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "Cargo por error del sistema." }),
    });

    const resuelto = await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/resolver-disputa`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ resolucion: "procede" }),
    });
    expect(resuelto.status).toBe(200);
    const resueltoBody = (await resuelto.json()) as { resolucionDisputa: string };
    expect(resueltoBody.resolucionDisputa).toBe("procede");

    const { rows } = await fixture.engine.admin.query<{ reversed_by: string | null }>(
      "select reversed_by from public.charge where id = $1;",
      [chargeId],
    );
    expect(rows[0]!.reversed_by).not.toBeNull();
  });

  it("resolver una disputa como 'improcede' NO reversa el cargo", async () => {
    const folioId = await nuevoFolio();
    const creado = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ monto: 40, tipoEvidencia: "foto", fotoUrl: "https://cdn.example.com/4.jpg" }),
    });
    const { id: consumptionId, chargeId } = (await creado.json()) as { id: string; chargeId: string };

    await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/disputa`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "El huésped dice que no fue él." }),
    });
    const resuelto = await fixture.app.request(`/hoteles/${hotelId}/minibar/${consumptionId}/resolver-disputa`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ resolucion: "improcede" }),
    });
    expect(resuelto.status).toBe(200);

    const { rows } = await fixture.engine.admin.query<{ reversed_by: string | null }>(
      "select reversed_by from public.charge where id = $1;",
      [chargeId],
    );
    expect(rows[0]!.reversed_by).toBeNull();
  });

  it("reporte periódico de tasa de disputas: sin registros en la ventana => sinDatos, nunca un 0% fabricado", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/minibar/reporte-disputas?desde=2099-01-01T00:00:00.000Z&hasta=2099-02-01T00:00:00.000Z`,
      { headers: auth(frontdeskToken) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinDatos: boolean; tasaDisputasPercent: number | null; dentroDelUmbral: boolean | null };
    expect(body.sinDatos).toBe(true);
    expect(body.tasaDisputasPercent).toBeNull();
    expect(body.dentroDelUmbral).toBeNull();
  });

  it("reporte periódico de tasa de disputas: calcula la tasa real y la compara contra el umbral (<3%)", async () => {
    // Ventana de tiempo propia para este test (registered_at >= 'inicio'), aislada de
    // los consumos creados por los tests anteriores -- evita que el orden de ejecución
    // de la suite contamine el conteo del reporte.
    const inicio = new Date().toISOString();

    const folioId = await nuevoFolio();
    const chargeIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/minibar`, {
        method: "POST",
        headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
        body: JSON.stringify({ monto: 30, tipoEvidencia: "foto", fotoUrl: `https://cdn.example.com/rep-${i}.jpg` }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      chargeIds.push(id);
    }
    // Exactamente 1 de 10 disputado = 10% -- deliberadamente POR ENCIMA del umbral
    // objetivo (<3%) para probar el caso en el que el reporte marca "fuera de umbral",
    // no solo el camino feliz.
    await fixture.app.request(`/hoteles/${hotelId}/minibar/${chargeIds[0]}/disputa`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "Disputa de prueba para el reporte." }),
    });

    const res = await fixture.app.request(
      `/hoteles/${hotelId}/minibar/reporte-disputas?desde=${encodeURIComponent(inicio)}`,
      { headers: auth(frontdeskToken) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalRegistrados: number;
      totalDisputados: number;
      tasaDisputasPercent: number;
      dentroDelUmbral: boolean;
      sinDatos: boolean;
    };
    expect(body.sinDatos).toBe(false);
    expect(body.totalRegistrados).toBe(10);
    expect(body.totalDisputados).toBe(1);
    expect(body.tasaDisputasPercent).toBeCloseTo(10, 5);
    expect(body.dentroDelUmbral).toBe(false);
  });
});
