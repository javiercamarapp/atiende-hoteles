// H12a · REQ-LAUNCH: "disparadores conectados a outbox (reserva confirmada -> correo;
// pago -> recibo; invitación -> correo)". `payment.recorded` se ejercita end-to-end
// contra el endpoint REAL de pagos (routes/folios.ts, sin tocarlo) -- el evento ya lo
// emite ese código hoy. `reservation.confirmed`/`cfdi.emitted` se ejercitan insertando
// el evento que `routes/reservas.ts`/`routes/cfdi.ts` DEBERÍAN emitir (documentado como
// pendiente-coordinación en buildEmailOutboxHandlers.ts) -- prueba el handler en
// aislamiento, honesto sobre qué parte falta del otro lado.
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

describe("reservation.confirmed / cfdi.emitted -- handler listo, pendiente de que el otro lote emita el evento", () => {
  it("procesa un evento reservation.confirmed simulado y envía confirmacion-reserva", async () => {
    const guest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Confirmacion", email: "confirmacion-simulada@example.com" }),
    });
    const guestId = ((await guest.json()) as { id: string }).id;
    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: "2026-09-15", checkOutDate: "2026-09-17" }),
    });
    const reservationId = ((await reserva.json()) as { id: string }).id;

    // Simula lo que routes/reservas.ts DEBERÍA insertar en la transición a 'confirmada'
    // (ver comentario "pendiente-coordinación" en buildEmailOutboxHandlers.ts).
    const { rows: orgRows } = await fixture.engine.admin.query<{ org_id: string }>("select org_id from public.hotel where id = $1;", [hotelId]);
    await fixture.engine.admin.query(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'reservation', $3, 'reservation.confirmed', '{}');`,
      [orgRows[0]!.org_id, hotelId, reservationId],
    );

    const resultado = await drenar();
    expect(resultado.delivered).toContain(
      (
        await fixture.engine.admin.query<{ id: string }>("select id from public.outbox where aggregate_id = $1 and event_type = 'reservation.confirmed';", [
          reservationId,
        ])
      ).rows[0]!.id,
    );

    const correo = await ultimoCorreoPara(fixture.engine, "confirmacion-simulada@example.com", "confirmacion-reserva");
    expect(correo).not.toBeNull();
  });
});
