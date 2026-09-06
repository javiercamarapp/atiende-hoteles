// H2 · Worker de outbox (apps/api/src/outbox/worker.ts): backoff exponencial con techo
// y dead-letter tras `maxAttempts`. `computeBackoffMs` se prueba como función pura;
// `drainOutboxOnce` se prueba contra PGlite (admin, bypassa RLS: el worker es un proceso
// de infraestructura, no una sesión de usuario final).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBackoffMs, drainOutboxOnce } from "@atiende-hoteles/api";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

describe("computeBackoffMs: backoff exponencial con techo", () => {
  it("crece exponencialmente hasta el techo configurado", () => {
    expect(computeBackoffMs(0, 1000, 60_000)).toBe(1000);
    expect(computeBackoffMs(1, 1000, 60_000)).toBe(2000);
    expect(computeBackoffMs(2, 1000, 60_000)).toBe(4000);
    expect(computeBackoffMs(3, 1000, 60_000)).toBe(8000);
    expect(computeBackoffMs(10, 1000, 60_000)).toBe(60_000); // techo, no sigue creciendo
  });
});

describe("drainOutboxOnce: reintentos y dead-letter", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  async function insertOutboxEvent(eventType: string) {
    const hotelA = fixture.seed.hotels[0]!;
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'reservation', gen_random_uuid(), $3, '{}'::jsonb)
       returning id;`,
      [fixture.seed.orgId, hotelA.id, eventType],
    );
    return rows[0]!.id;
  }

  it("un handler exitoso marca el evento 'enviado' y no lo vuelve a drenar", async () => {
    const id = await insertOutboxEvent("reservation.created");
    let calls = 0;

    const result = await drainOutboxOnce(fixture.engine.admin, {
      handlers: { "reservation.created": async () => { calls += 1; } },
    });

    expect(result.delivered).toEqual([id]);
    expect(calls).toBe(1);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("enviado");

    // Una segunda pasada no debe volver a llamar al handler (ya no está 'pendiente').
    const second = await drainOutboxOnce(fixture.engine.admin, {
      handlers: { "reservation.created": async () => { calls += 1; } },
    });
    expect(second.delivered).toEqual([]);
    expect(calls).toBe(1);
  });

  it("un handler que falla incrementa attempts y pospone available_at con backoff exponencial", async () => {
    const id = await insertOutboxEvent("payment.recorded");

    const result = await drainOutboxOnce(fixture.engine.admin, {
      handlers: {
        "payment.recorded": async () => {
          throw new Error("conector caído");
        },
      },
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
    });

    expect(result.retried).toEqual([id]);

    const { rows } = await fixture.engine.admin.query<{ status: string; attempts: number; available_at: string }>(
      "select status, attempts, available_at from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("pendiente");
    expect(rows[0]!.attempts).toBe(1);
    // available_at debe quedar en el futuro (backoff aplicado), no en el pasado/ahora.
    expect(new Date(rows[0]!.available_at).getTime()).toBeGreaterThan(Date.now());

    // Mientras available_at siga en el futuro, una nueva pasada NO debe reintentar todavía.
    const notYet = await drainOutboxOnce(fixture.engine.admin, {
      handlers: { "payment.recorded": async () => {} },
    });
    expect(notYet.delivered).toEqual([]);
  });

  it("tras maxAttempts fallos consecutivos, el evento se marca 'fallido' (dead-letter) y deja de reintentarse", async () => {
    const id = await insertOutboxEvent("reservation.created");

    // Fuerza el evento a estar disponible ahora mismo en cada intento (sin esperar el
    // backoff real) y ya con 2 intentos previos, para llegar rápido a maxAttempts=3.
    await fixture.engine.admin.query(
      "update public.outbox set attempts = 2, available_at = now() where id = $1;",
      [id],
    );

    const result = await drainOutboxOnce(fixture.engine.admin, {
      handlers: {
        "reservation.created": async () => {
          throw new Error("conector caído de forma permanente");
        },
      },
      maxAttempts: 3,
    });

    expect(result.deadLettered).toEqual([id]);

    const { rows } = await fixture.engine.admin.query<{ status: string; attempts: number }>(
      "select status, attempts from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("fallido");
    expect(rows[0]!.attempts).toBe(3);

    // Un evento 'fallido' nunca vuelve a drenarse automáticamente (fail-cerrado, ADR-004).
    const again = await drainOutboxOnce(fixture.engine.admin, {
      handlers: { "reservation.created": async () => {} },
    });
    expect(again.delivered).toEqual([]);
    expect(again.retried).toEqual([]);
  });

  it("auditoria-1/backend [ALTO]: la causa real del error queda persistida en outbox.last_error, no descartada por un catch{} mudo", async () => {
    const id = await insertOutboxEvent("payment.recorded");

    await drainOutboxOnce(fixture.engine.admin, {
      handlers: {
        "payment.recorded": async () => {
          throw new Error("conector CFDI respondió 500: payload inesperado");
        },
      },
      maxAttempts: 5,
    });

    const { rows } = await fixture.engine.admin.query<{ last_error: string | null }>(
      "select last_error from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.last_error).toMatch(/conector CFDI respondió 500/);
  });

  it("auditoria-1/backend [ALTO]: el dead-letter final también conserva la causa real del último intento", async () => {
    const id = await insertOutboxEvent("reservation.created");
    await fixture.engine.admin.query(
      "update public.outbox set attempts = 2, available_at = now() where id = $1;",
      [id],
    );

    await drainOutboxOnce(fixture.engine.admin, {
      handlers: {
        "reservation.created": async () => {
          throw new Error("PMS inalcanzable: ECONNREFUSED");
        },
      },
      maxAttempts: 3,
    });

    const { rows } = await fixture.engine.admin.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("fallido");
    expect(rows[0]!.last_error).toMatch(/PMS inalcanzable/);
  });

  it("auditoria-1/backend [ALTO]: un handler colgado (nunca resuelve) se trata como fallo por timeout sin bloquear el resto del batch", async () => {
    const idColgado = await insertOutboxEvent("payment.recorded");
    const idNormal = await insertOutboxEvent("reservation.created");

    let handlerNormalLlamado = false;
    const inicio = Date.now();
    const result = await drainOutboxOnce(fixture.engine.admin, {
      handlers: {
        "payment.recorded": () => new Promise(() => {}), // nunca resuelve ni rechaza
        "reservation.created": async () => {
          handlerNormalLlamado = true;
        },
      },
      handlerTimeoutMs: 50,
      maxAttempts: 5,
    });
    const duracionMs = Date.now() - inicio;

    // El batch completo terminó rápido (no esperó indefinidamente al handler colgado)
    // y SÍ llegó a procesar el segundo evento del mismo batch.
    expect(duracionMs).toBeLessThan(2000);
    expect(handlerNormalLlamado).toBe(true);
    expect(result.delivered).toEqual([idNormal]);
    expect(result.retried).toEqual([idColgado]);

    const { rows } = await fixture.engine.admin.query<{ last_error: string | null }>(
      "select last_error from public.outbox where id = $1;",
      [idColgado],
    );
    expect(rows[0]!.last_error).toMatch(/handler_timeout/);
  });

  it("un event_type sin handler registrado se trata como fallo (nunca se marca 'enviado' silenciosamente)", async () => {
    const id = await insertOutboxEvent("evento.sin.manejador");

    const result = await drainOutboxOnce(fixture.engine.admin, { handlers: {}, maxAttempts: 5 });
    expect(result.retried).toEqual([id]);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.outbox where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("pendiente");
  });
});
