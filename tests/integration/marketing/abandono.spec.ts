// REQ-RES-011 (docs/REQUISITOS.md): "El sistema debe detectar reservas/cotizaciones
// abandonadas en el motor propio y contactar al huésped dentro de ventanas definidas
// (p.ej. 10 min, 2h, 24h) ofreciendo ayuda o un incentivo no monetario." Criterio de
// aceptación literal (docs/ACEPTACION.md): "Cotización abandonada detectada por el motor
// propio dispara contacto en las ventanas configuradas (10 min, 2h, 24h) con oferta no
// monetaria; prueba de tiempo simulado confirma exactamente 3 contactos en esas
// ventanas, ninguno antes ni después."
//
// "Cotización del motor propio" = una `reservation` que nace `cotizada` (ADR-005) y
// nunca se confirmó (ver `packages/domain-hotel/src/reservas/quoteAbandonment.ts`).
// Contra embedded-postgres real (RLS real incluida), reloj SIEMPRE simulado/inyectado
// (nunca se espera un minuto real) -- creación de la reserva por la API real
// (`POST /hoteles/:hotelId/reservas`), detección+marcado+encolado por
// `jobs/quoteAbandonment.ts`, y entrega real de correo drenando `public.outbox` con los
// mismos handlers que `server.ts` ya usa (`buildEmailOutboxHandlers` + `FakeEmailAdapter`
// respaldado por `email_outbox`, sin tocar ningún proveedor real).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainOutboxOnce } from "@atiende-hoteles/api";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";
import { buildEmailOutboxHandlers } from "../../../apps/api/src/emailOutbox/buildEmailOutboxHandlers.ts";
import { detectAndMarkAbandonedQuotes } from "../../../apps/api/src/jobs/quoteAbandonment.ts";
import {
  loadHotelsForQuoteAbandonment,
  QuoteAbandonmentScheduler,
} from "../../../apps/api/src/jobs/quoteAbandonmentScheduler.ts";

// Mismo bug de CI que `email-outbox-handlers.spec.ts`/`reservas-y-folios.spec.ts`
// (10-sep-2026): fechas absolutas caen tarde o temprano fuera de la ventana de
// tarifa/disponibilidad sembrada por `seedDev` (siempre desde "hoy" real) -- SIEMPRE
// offsets relativos, nunca un literal.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// `created_at` viene de Postgres (timestamptz, precisión de microsegundos) pero
// `pg` lo entrega como `Date` de JS (precisión de milisegundos, trunca la fracción de
// microsegundo) -- mismo margen documentado en
// `tests/integration/tickets/sla-escalado.spec.ts` ("+1ms de margen sobre el umbral
// aproximado"): sin este margen, el `now` simulado (calculado sobre el `Date` YA
// truncado) puede quedar una fracción de milisegundo POR DEBAJO del valor real
// `created_at + N minutos` que SQL calcula sobre la columna sin truncar.
function enVentana(createdAt: Date, minutos: number): Date {
  return new Date(createdAt.getTime() + minutos * 60_000 + 1);
}

describe("REQ-RES-011: detección de cotizaciones abandonadas (motor propio) + contacto en 10min/2h/24h", () => {
  let fixture: ApiFixtureH12a;
  let hotelId: string;
  let tenantId: string;
  let ownerToken: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixtureH12a();
    hotelId = fixture.seed.hotels[0]!.id;
    tenantId = fixture.seed.orgId;
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

  beforeEach(async () => {
    // Cada `it` corre su propio escenario independiente sobre la MISMA base (mismo
    // criterio que otros archivos de integración de este repo) -- limpia reservas,
    // outbox y correo simulado entre pruebas para que el conteo "exactamente 3
    // contactos" de una prueba nunca vea filas de otra.
    await fixture.engine.admin.exec(
      "truncate table public.reservation, public.outbox, public.email_outbox, public.audit_log restart identity cascade;",
    );
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function crearHuespedConCorreo(nombre: string, email: string): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre, email }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  /** Crea una cotización real (`POST /reservas`, queda en `status = 'cotizada'` -- NUNCA
   *  se confirma) y devuelve su id + `created_at` real leído de la BD (el reloj de la
   *  transacción, no `Date.now()` de la prueba). */
  async function crearCotizacion(guestId: string): Promise<{ reservationId: string; createdAt: Date }> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(ownerToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: isoDate(10), checkOutDate: isoDate(12) }),
    });
    expect(res.status).toBe(201);
    const { id: reservationId, estado } = (await res.json()) as { id: string; estado: string };
    expect(estado).toBe("cotizada");

    const { rows } = await fixture.engine.admin.query<{ created_at: Date }>(
      "select created_at from public.reservation where id = $1;",
      [reservationId],
    );
    return { reservationId, createdAt: rows[0]!.created_at };
  }

  async function drenarCorreo() {
    return drainOutboxOnce(fixture.engine.admin, {
      handlers: buildEmailOutboxHandlers({ db: fixture.engine.admin, emailPort: fixture.emailAdapter }),
    });
  }

  async function correosDe(reservationId: string): Promise<{ dedupe_key: string | null; subject: string }[]> {
    const { rows } = await fixture.engine.admin.query<{ dedupe_key: string | null; subject: string }>(
      `select dedupe_key, subject from public.email_outbox
       where dedupe_key like $1
       order by created_at asc;`,
      [`cotizacion-abandonada:${reservationId}:%`],
    );
    return rows;
  }

  it("NO contacta un minuto antes de los 10 min (caso negativo: nada dispara antes de tiempo)", async () => {
    const guestId = await crearHuespedConCorreo("Huésped Cotización A", "cotizacion-a@example.com");
    const { reservationId, createdAt } = await crearCotizacion(guestId);

    const unMinutoAntes = new Date(createdAt.getTime() + 9 * 60_000);
    const resultado = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => unMinutoAntes });

    expect(resultado.contacted.map((c) => c.reservationId)).not.toContain(reservationId);
    expect(await correosDe(reservationId)).toHaveLength(0);
  });

  it("dispara EXACTAMENTE 3 contactos en 10min/2h/24h, ninguno antes ni después, con oferta no monetaria por ventana", async () => {
    const guestId = await crearHuespedConCorreo("Huésped Cotización B", "cotizacion-b@example.com");
    const { reservationId, createdAt } = await crearCotizacion(guestId);

    // --- Ventana 1: 10 minutos ---
    const en10min = enVentana(createdAt, 10);
    const r1 = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => en10min });
    expect(r1.contacted).toEqual([{ reservationId, guestId, window: "10m" }]);

    // Repetir el MISMO instante es idempotente -- no vuelve a marcar la ventana de 10m.
    const r1Repetido = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => en10min });
    expect(r1Repetido.contacted).toHaveLength(0);

    // --- Ventana 2: 2 horas (todavía NO debe disparar la de 24h) ---
    const en2h = enVentana(createdAt, 120);
    const r2 = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => en2h });
    expect(r2.contacted).toEqual([{ reservationId, guestId, window: "2h" }]);

    // --- Ventana 3: 24 horas ---
    const en24h = enVentana(createdAt, 1440);
    const r3 = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => en24h });
    expect(r3.contacted).toEqual([{ reservationId, guestId, window: "24h" }]);

    // Mucho después de las 3 ventanas: ya no queda ninguna ventana pendiente que marcar.
    const muchoDespues = new Date(createdAt.getTime() + 7 * 24 * 60 * 60_000);
    const r4 = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => muchoDespues });
    expect(r4.contacted.map((c) => c.reservationId)).not.toContain(reservationId);

    // El drenado real de `outbox` -> correo entrega EXACTAMENTE 3 correos distintos
    // (uno por ventana, mismo `reservationId`), nunca más, nunca menos.
    await drenarCorreo();
    const correos = await correosDe(reservationId);
    expect(correos).toHaveLength(3);
    expect(correos.map((c) => c.dedupe_key)).toEqual([
      `cotizacion-abandonada:${reservationId}:10m`,
      `cotizacion-abandonada:${reservationId}:2h`,
      `cotizacion-abandonada:${reservationId}:24h`,
    ]);
    // Ninguno de los 3 correos ofrece dinero -- "incentivo NO monetario" (criterio
    // literal del REQ), verificado sobre el HTML realmente entregado, no solo sobre el
    // catálogo de dominio (ya cubierto en el unit test).
    const { rows: htmlRows } = await fixture.engine.admin.query<{ html: string }>(
      "select html from public.email_outbox where dedupe_key = $1;",
      [`cotizacion-abandonada:${reservationId}:24h`],
    );
    expect(htmlRows[0]!.html.toLowerCase()).not.toContain("descuento");

    // Bitácora auditable de las 3 ventanas (REQ-RES-011 "contactar al huésped" --
    // rastro real de esa decisión, mismo criterio que `guest_ticket.escalado`).
    const { rows: auditRows } = await fixture.engine.admin.query<{ payload: { ventana: string } }>(
      "select payload from public.audit_log where hotel_id = $1 and action = 'reservation.abandono_contactado' order by created_at asc;",
      [hotelId],
    );
    expect(auditRows.map((r) => r.payload.ventana)).toEqual(["10m", "2h", "24h"]);
  });

  it("una cotización CONFIRMADA antes de una ventana nunca recibe ese contacto (caso negativo: confirmar detiene el abandono)", async () => {
    const guestId = await crearHuespedConCorreo("Huésped Cotización C", "cotizacion-c@example.com");
    const { reservationId } = await crearCotizacion(guestId);

    const confirmar = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(confirmar.status).toBe(200);

    // Reloj simulado muy por delante de las 3 ventanas -- si la reserva siguiera
    // `cotizada` ya habría disparado las 3; al estar `confirmada`, ninguna aplica.
    const muchoDespues = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    const resultado = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => muchoDespues });

    expect(resultado.contacted.map((c) => c.reservationId)).not.toContain(reservationId);
    await drenarCorreo();
    expect(await correosDe(reservationId)).toHaveLength(0);
  });

  it("una cotización CANCELADA antes de una ventana nunca recibe ese contacto", async () => {
    const guestId = await crearHuespedConCorreo("Huésped Cotización D", "cotizacion-d@example.com");
    const { reservationId } = await crearCotizacion(guestId);

    const cancelar = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/cancelar`, {
      method: "POST",
      headers: auth(ownerToken),
    });
    expect(cancelar.status).toBe(200);

    const muchoDespues = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    const resultado = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => muchoDespues });

    expect(resultado.contacted.map((c) => c.reservationId)).not.toContain(reservationId);
  });

  it("el planificador (QuoteAbandonmentScheduler) detecta de punta a punta contra TODOS los hoteles reales, con reloj inyectado", async () => {
    const guestId = await crearHuespedConCorreo("Huésped Cotización E", "cotizacion-e@example.com");
    const { reservationId, createdAt } = await crearCotizacion(guestId);

    const hotels = await loadHotelsForQuoteAbandonment(fixture.engine.admin);
    expect(hotels.some((h) => h.id === hotelId)).toBe(true);

    const scheduler = new QuoteAbandonmentScheduler(fixture.engine.admin, {
      now: () => enVentana(createdAt, 10),
    });
    const tickResults = await scheduler.tick(hotels);
    const hotelResult = tickResults.find((r) => r.hotelId === hotelId)!;
    expect(hotelResult.ran).toBe(true);
    expect(hotelResult.result?.contacted.map((c) => c.reservationId)).toContain(reservationId);

    // Corriendo el mismo tick otra vez de inmediato para el mismo hotel no lo salta por
    // "ya en progreso" (el `tick` anterior ya terminó) ni duplica el contacto de 10m.
    const segundoTick = await scheduler.tick(hotels);
    expect(segundoTick.find((r) => r.hotelId === hotelId)?.result?.contacted ?? []).toHaveLength(0);
  });

  it("una cotización sin correo del huésped en el expediente no genera ningún correo, pero SÍ queda marcada/auditada (nunca bloquea la detección)", async () => {
    const sinCorreo = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ nombre: "Huésped Sin Correo" }),
    });
    expect(sinCorreo.status).toBe(201);
    const guestId = ((await sinCorreo.json()) as { id: string }).id;
    const { reservationId, createdAt } = await crearCotizacion(guestId);

    const en10min = enVentana(createdAt, 10);
    const resultado = await detectAndMarkAbandonedQuotes(fixture.engine.admin, { hotelId, tenantId }, { now: () => en10min });
    expect(resultado.contacted.map((c) => c.reservationId)).toContain(reservationId);

    await drenarCorreo();
    expect(await correosDe(reservationId)).toHaveLength(0);
  });
});
