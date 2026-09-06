// auditoria-1/datos [MEDIO] "el worker de outbox no tiene un índice que sirva su propia
// consulta -- full scan garantizado a escala" (docs/auditoria-1/datos.md). Reproduce el
// EXPLAIN real que citó la auditoría (Seq Scan sin el índice nuevo) y confirma que
// `outbox_status_created_idx` (migración 0021) lo elimina para la consulta EXACTA de
// `drainOutboxOnce()` (apps/api/src/outbox/worker.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

const WORKER_QUERY = `
  explain (format text)
  select id, tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload, attempts
  from public.outbox
  where status = 'pendiente' and available_at <= now()
  order by created_at asc
  limit 20;
`;

describe("outbox: el índice (status, created_at) sirve la consulta real del worker a escala (auditoria-1/datos MEDIO)", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
    const hotelA = fixture.seed.hotels[0]!;

    // Volumen suficiente para que el planificador de costos prefiera el índice sobre un
    // seq scan (con pocas filas, Postgres elige seq scan sin importar el índice -- el
    // propio hallazgo original se verificó con ~7,000 filas).
    await fixture.engine.admin.exec(`
      insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload, status, available_at)
      select
        '${fixture.seed.orgId}'::uuid,
        '${hotelA.id}'::uuid,
        'reservation',
        gen_random_uuid(),
        'reservation.created',
        '{}'::jsonb,
        (array['pendiente','enviado','fallido'])[1 + floor(random() * 3)]::public.outbox_status,
        now() - (floor(random() * 1000) || ' minutes')::interval
      from generate_series(1, 8000);
    `);
    await fixture.engine.admin.exec("analyze public.outbox;");
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("EXPLAIN de la consulta real del worker ya NO produce un Seq Scan sobre outbox", async () => {
    const { rows } = await fixture.engine.admin.query<{ "QUERY PLAN": string }>(WORKER_QUERY);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");

    expect(plan).not.toMatch(/Seq Scan on (public\.)?outbox/);
    expect(plan).toMatch(/outbox_status_created_idx/);
  });
});
