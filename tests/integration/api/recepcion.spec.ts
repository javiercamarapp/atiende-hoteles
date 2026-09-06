// auditoria-2/frontend [ALTO] · GET /hoteles/:hotelId/recepcion no existía en ningún
// archivo de apps/api/src/routes/*.ts (el panel llamaba una ruta 404 y el error se
// atribuía falsamente a "credenciales del PMS"). Esta prueba fija el contrato real del
// endpoint nuevo (routes/recepcion.ts): lee `reservation_status_event` -- append-only,
// escrita por trigger en cada transición real de `reservation.status` -- sin depender de
// ninguna integración externa.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("GET /hoteles/:hotelId/recepcion (auditoria-2/frontend)", () => {
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

  async function transicion(reservationId: string, toStatus: string) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ toStatus }),
    });
    expect(res.status).toBe(200);
  }

  it("sin ningún movimiento de check-in/check-out todavía: [] honesto (nunca un error)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/recepcion`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("refleja check-in y check-out reales una vez que la reserva transiciona (sin PMS)", async () => {
    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-09-20", checkOutDate: "2026-09-22" }),
    });
    expect(created.status).toBe(201);
    const { id: reservationId } = (await created.json()) as { id: string };

    await transicion(reservationId, "confirmada");
    await transicion(reservationId, "check_in");

    const afterCheckIn = await fixture.app.request(`/hoteles/${hotelId}/recepcion`, { headers: auth() });
    expect(afterCheckIn.status).toBe(200);
    const movimientosCheckIn = (await afterCheckIn.json()) as { tipo: string; habitacion: string; hora: string }[];
    expect(movimientosCheckIn.some((m) => m.tipo === "check-in")).toBe(true);
    expect(movimientosCheckIn[0]!.habitacion).toBeTruthy();
    expect(movimientosCheckIn[0]!.hora).toMatch(/^\d{2}:\d{2}$/);

    await transicion(reservationId, "en_estancia");
    await transicion(reservationId, "check_out");

    const afterCheckOut = await fixture.app.request(`/hoteles/${hotelId}/recepcion`, { headers: auth() });
    const movimientos = (await afterCheckOut.json()) as { tipo: string }[];
    expect(movimientos.some((m) => m.tipo === "check-in")).toBe(true);
    expect(movimientos.some((m) => m.tipo === "check-out")).toBe(true);
    // en_estancia no es check-in ni check-out: no debe aparecer una tercera fila extra
    // para esta reserva más allá de las dos transiciones que sí cuentan.
    expect(movimientos.length).toBe(2);
  });

  it("requiere ser miembro del hotel (mismo criterio que /reservas)", async () => {
    const hotelB = fixture.seed.hotels[1]!;
    const otroToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
    const res = await fixture.app.request(`/hoteles/${hotelId}/recepcion`, {
      headers: { authorization: `Bearer ${otroToken}` },
    });
    expect(res.status).toBe(403);
  });
});
