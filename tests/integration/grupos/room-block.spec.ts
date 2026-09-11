// REQ-RES-012 (embedded-postgres real) -- "bloqueo de habitaciones (room block) y
// seguimiento de cut-off" (H02-016/H05-013): confirmar un bloque bloquea inventario
// REAL en `public.availability` (no solo un número en la cotización); liberar/cancelar
// devuelve exactamente lo que quedó SIN recoger; y la alerta de cut-off refleja pickup
// real. El criterio de aceptación LITERAL de REQ-RES-012 (cotización + desplazamiento
// de ADR) ya se prueba en cotizacion.spec.ts -- este archivo cubre el resto del texto
// del requisito (room block + cut-off), fuera del alcance de ese criterio puntual.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("ciclo de vida del room block (REQ-RES-012, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let dates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 4;",
      [hotelId, roomTypeId],
    );
    dates = seededDates.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function bookedRoomsFor(date: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query<{ booked_rooms: number }>(
      "select booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, date],
    );
    return rows[0]!.booked_rooms;
  }

  function auth(token: string = gmToken) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("confirmar un bloque bloquea inventario real; liberar con pickup parcial devuelve solo lo no recogido", async () => {
    const cotizacion = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        roomTypeId,
        organizerName: "Grupo Retiro Yoga",
        organizerEmail: "retiro@planner-demo.mx",
        eventType: "retiro",
        checkInDate: dates[0],
        checkOutDate: dates[1],
        roomsRequested: 3,
        manualPrice: 9000,
        currency: "MXN",
        cutoffDate: dates[0],
      }),
    });
    expect(cotizacion.status).toBe(201);
    const { id, status: estadoInicial } = (await cotizacion.json()) as { id: string; status: string };
    expect(estadoInicial).toBe("cotizado");

    // Antes de confirmar: cotizar NUNCA toca el inventario real.
    expect(await bookedRoomsFor(dates[0]!)).toBe(0);

    const confirmado = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/confirmar`, {
      method: "POST",
      headers: auth(),
    });
    expect(confirmado.status).toBe(200);
    const confirmadoBody = (await confirmado.json()) as { status: string; confirmedAt: string | null };
    expect(confirmadoBody.status).toBe("confirmado");
    expect(confirmadoBody.confirmedAt).not.toBeNull();

    // Confirmar SÍ bloqueó las 3 habitaciones reales de esa noche.
    expect(await bookedRoomsFor(dates[0]!)).toBe(3);

    // Confirmar dos veces está prohibido (ya no está en "cotizado").
    const doblConfirmar = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/confirmar`, {
      method: "POST",
      headers: auth(),
    });
    expect(doblConfirmar.status).toBe(409);

    // Solo se recogieron 2 de las 3 habitaciones bloqueadas.
    const pickup = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/pickup`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ roomsPickedUp: 2 }),
    });
    expect(pickup.status).toBe(200);

    // Cut-off ya vencido (cutoffDate = dates[0], que ya es "hoy" o antes en el reloj
    // de Postgres de este fixture) con pickup insuficiente -> alerta "critica".
    const alerta = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/cutoff-alerta`, {
      headers: auth(),
    });
    expect(alerta.status).toBe(200);
    const alertaBody = (await alerta.json()) as { alertLevel: string };
    expect(alertaBody.alertLevel).toBe("critica");

    const liberado = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/liberar`, {
      method: "POST",
      headers: auth(),
    });
    expect(liberado.status).toBe(200);
    const liberadoBody = (await liberado.json()) as { status: string; releasedAt: string | null };
    expect(liberadoBody.status).toBe("liberado");
    expect(liberadoBody.releasedAt).not.toBeNull();

    // Solo se liberó 1 habitación (3 bloqueadas - 2 recogidas) -- las 2 recogidas
    // siguen ocupadas, nunca se libera de más.
    expect(await bookedRoomsFor(dates[0]!)).toBe(2);
  });

  it("cancelar un bloque confirmado sin ningún pickup libera el bloque completo", async () => {
    const cotizacion = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        roomTypeId,
        organizerName: "Boda Cancelada",
        organizerEmail: "boda@planner-demo.mx",
        eventType: "boda",
        checkInDate: dates[2],
        checkOutDate: dates[3],
        roomsRequested: 2,
        manualPrice: 6000,
        currency: "MXN",
      }),
    });
    expect(cotizacion.status).toBe(201);
    const { id } = (await cotizacion.json()) as { id: string };

    await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/confirmar`, { method: "POST", headers: auth() });
    expect(await bookedRoomsFor(dates[2]!)).toBe(2);

    const cancelado = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${id}/cancelar`, {
      method: "POST",
      headers: auth(),
    });
    expect(cancelado.status).toBe(200);
    expect(((await cancelado.json()) as { status: string }).status).toBe("cancelado");
    expect(await bookedRoomsFor(dates[2]!)).toBe(0);
  });
});
