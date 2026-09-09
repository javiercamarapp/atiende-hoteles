// H12a · REQ-LAUNCH: "disparadores conectados a outbox (reserva confirmada -> correo;
// pago -> recibo; invitación -> correo)". Los 3 disparadores se ejercitan end-to-end
// contra los endpoints REALES (routes/folios.ts, routes/reservas.ts, routes/cfdi.ts) --
// el pendiente-coordinación de `reservation.confirmed`/`cfdi.emitted` (documentado
// originalmente en buildEmailOutboxHandlers.ts) se cerró en el merge de H12a a main:
// ambas rutas insertan ahora el evento correspondiente en `public.outbox`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOutboxOnce } from "@atiende-hoteles/api";
import { buildEmailOutboxHandlers } from "../../../apps/api/src/emailOutbox/buildEmailOutboxHandlers.ts";
import { createApiFixtureH12a, destroyApiFixtureH12a, ultimoCorreoPara, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;
let hotelId: string;
let ownerToken: string;
let roomTypeId: string;

beforeAll(async () => {
  fixture = await createApiFixtureH12a();
  hotelId = fixture.seed.hotels[0]!.id;
  roomTypeId = fixture.seed.hotels[0]!.roomTypes[0]!.id;
  const ownerEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
  const login = await fixture.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "atiende-dev-2026" }),
  });
  ownerToken = ((await login.json()) as { token: string }).token;
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function drenar() {
  return drainOutboxOnce(fixture.engine.admin, {
    handlers: buildEmailOutboxHandlers({ db: fixture.engine.admin, emailPort: fixture.emailAdapter }),
  });
}

describe("payment.recorded -> recibo-pago (disparador REAL, sin tocar routes/folios.ts)", () => {
  it("un pago real contra el endpoint de folios encola y envía el recibo al huésped", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Con Correo", email: "huesped-recibo@example.com" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;

    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-10", checkOutDate: "2026-09-12" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;

    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    const folioId = ((await confirmada.json()) as { folioId: string }).folioId;

    const pago = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ monto: 500, metodo: "efectivo" }),
    });
    expect(pago.status).toBe(201);
    const paymentId = ((await pago.json()) as { id: string }).id;

    const resultado = await drenar();
    const { rows: outboxRow } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.outbox where event_type = 'payment.recorded' and aggregate_id = $1;",
      [paymentId],
    );
    // El evento de ESTE pago se entregó -- otros eventos pendientes de la misma corrida
    // (p. ej. `reservation.created`, que este conjunto de handlers no cubre a propósito,
    // ver cabecera del archivo) pueden seguir reintentando sin que eso sea un fallo de
    // ESTE disparador.
    expect(resultado.delivered).toContain(outboxRow[0]!.id);

    const correo = await ultimoCorreoPara(fixture.engine, "huesped-recibo@example.com", "recibo-pago");
    expect(correo).not.toBeNull();
    expect(correo!.html).toContain("$500.00");
  });

  it("un pago sin correo de huésped en el expediente no falla el drenado (se trata como entregado, nada que enviar)", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Sin Correo" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;
    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-13", checkOutDate: "2026-09-14" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;
    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    const folioId = ((await confirmada.json()) as { folioId: string }).folioId;
    const pago = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ monto: 300, metodo: "efectivo" }),
    });
    const paymentId = ((await pago.json()) as { id: string }).id;

    const resultado = await drenar();
    const { rows: outboxRow } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.outbox where event_type = 'payment.recorded' and aggregate_id = $1;",
      [paymentId],
    );
    // Sin correo en el expediente del huésped: el evento se entrega igual (nada que
    // reintentar), nunca queda en 'retried'/'deadLettered' por esta causa.
    expect(resultado.delivered).toContain(outboxRow[0]!.id);
  });
});

describe("reservation.confirmed -> confirmacion-reserva (disparador REAL, routes/reservas.ts)", () => {
  it("confirmar una reserva real por la API encola y envía la confirmación al huésped", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Confirmacion", email: "confirmacion-real@example.com" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;
    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-15", checkOutDate: "2026-09-17" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;

    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(confirmada.status).toBe(200);

    // routes/reservas.ts inserta el evento por sí mismo dentro de la transición -- sin
    // simular nada aquí, solo se verifica que ya está en la tabla antes de drenar.
    const { rows: outboxRow } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.outbox where event_type = 'reservation.confirmed' and aggregate_id = $1;",
      [reservationId],
    );
    expect(outboxRow.length).toBe(1);

    const resultado = await drenar();
    expect(resultado.delivered).toContain(outboxRow[0]!.id);

    const correo = await ultimoCorreoPara(fixture.engine, "confirmacion-real@example.com", "confirmacion-reserva");
    expect(correo).not.toBeNull();
  });

  it("repetir la transición a 'confirmada' sobre la misma reserva no duplica el correo (dedupeKey del EmailPort)", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Reconfirmado", email: "reconfirmado@example.com" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;
    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-18", checkOutDate: "2026-09-19" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;

    for (let i = 0; i < 2; i++) {
      await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
        method: "PATCH",
        headers: auth(ownerToken),
        body: JSON.stringify({ toStatus: "confirmada" }),
      });
    }
    await drenar();

    const { rows: enviados } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.email_outbox where to_email = $1 and template = 'confirmacion-reserva';",
      ["reconfirmado@example.com"],
    );
    expect(enviados[0]!.count).toBe("1");
  });
});

describe("cfdi.emitted -> cfdi-disponible (disparador REAL, routes/cfdi.ts)", () => {
  it("timbrar el CFDI de hospedaje de un folio real encola y envía el aviso al huésped", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped CFDI", email: "cfdi-disponible@example.com" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;
    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-20", checkOutDate: "2026-09-21" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;
    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    const folioId = ((await confirmada.json()) as { folioId: string }).folioId;
    await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }),
    });

    const cfdi = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
    });
    expect(cfdi.status).toBe(201);
    const cfdiId = ((await cfdi.json()) as { id: string }).id;

    const { rows: outboxRow } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.outbox where event_type = 'cfdi.emitted' and aggregate_id = $1;",
      [cfdiId],
    );
    expect(outboxRow.length).toBe(1);

    const resultado = await drenar();
    expect(resultado.delivered).toContain(outboxRow[0]!.id);

    const correo = await ultimoCorreoPara(fixture.engine, "cfdi-disponible@example.com", "cfdi-disponible");
    expect(correo).not.toBeNull();
  });
});
