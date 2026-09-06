// H4 · auditoría-1/pruebas: "incluye una prueba adversarial con dos requests
// concurrentes con la misma Idempotency-Key en POST de reserva/pago (una sola
// escritura)". El diseño de `apps/api/src/lib/idempotency.ts` (reclamo con
// `insert ... on conflict do nothing` ANTES de correr la mutación, dentro de la MISMA
// transacción de sesión por request) da, en teoría, la serialización correcta bajo
// concurrencia real porque un INSERT que choca contra una fila reclamada por OTRA
// transacción en vuelo espera el commit/rollback de esa transacción -- esta prueba lo
// verifica de verdad contra `embedded-postgres` real (conexiones de sistema operativo
// distintas), no solo lee el código y confía en el diseño.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: Idempotency-Key idéntica en requests CONCURRENTES (auditoría-1/pruebas)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let seededDates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    seededDates = rows.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}` };
  }

  it("dos POST /reservas concurrentes con la MISMA Idempotency-Key crean una sola reserva (una gana, la otra recibe la MISMA respuesta)", async () => {
    const checkIn = seededDates[0]!;
    const checkOut = seededDates[1]!;
    const key = randomUUID();
    const body = { roomTypeId, checkInDate: checkIn, checkOutDate: checkOut };

    const disparar = () =>
      fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });

    const [a, b] = await Promise.all([disparar(), disparar()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const [bodyA, bodyB] = (await Promise.all([a.json(), b.json()])) as { id: string }[];
    expect(bodyA.id).toBe(bodyB.id); // ambas respuestas apuntan a LA MISMA reserva

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where hotel_id = $1 and room_type_id = $2 and check_in_date = $3 and check_out_date = $4;",
      [hotelId, roomTypeId, checkIn, checkOut],
    );
    // Una sola fila de verdad en la tabla -- no dos reservas duplicadas por la carrera.
    expect(rows[0]!.count).toBe("1");

    const { rows: idempotencyRows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.idempotency_key where scope = 'reservation.create' and key = $1;",
      [key],
    );
    expect(idempotencyRows[0]!.count).toBe("1"); // una sola fila de reclamo, no una por request
  });

  it("dos POST /pagos concurrentes con la MISMA Idempotency-Key sobre el mismo folio registran un solo pago", async () => {
    // Folio real alcanzado por la API (confirmar la reserva), sin cliente admin -- ver
    // tests/integration/reservas/folio-al-confirmar.spec.ts para la prueba dedicada del
    // hallazgo ALTO de creación de folio.
    const checkIn = seededDates[3]!;
    const checkOut = seededDates[4]!;
    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    const { id: reservationId } = (await creada.json()) as { id: string };

    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    const { folioId } = (await confirmada.json()) as { folioId: string };
    expect(folioId).toBeTruthy();

    const key = randomUUID();
    const disparar = () =>
      fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ monto: 500, metodo: "tarjeta" }),
      });

    const [a, b] = await Promise.all([disparar(), disparar()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const [bodyA, bodyB] = (await Promise.all([a.json(), b.json()])) as { id: string }[];
    expect(bodyA.id).toBe(bodyB.id);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.payment where folio_id = $1;",
      [folioId],
    );
    expect(rows[0]!.count).toBe("1"); // un solo pago, no dos cobros duplicados al huésped
  });
});
