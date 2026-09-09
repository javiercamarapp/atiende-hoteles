// H18 · conector-pms-enterprise: `OutboundTaskSyncGateway` resuelve la configuración
// real de `hotel_pms_outbound_config` (packages/db/migrations/0127) contra un Postgres
// real (PGlite) y decide si llama al `OutboundTaskSyncPort` inyectado -- aquí se usa
// `FakeOutboundTaskSyncAdapter` para no depender de red, mismo criterio que
// `tests/unit/mcp-servers/payments/adapter-swap.spec.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeOutboundTaskSyncAdapter, OutboundTaskSyncGateway, type OutboundTask } from "@atiende-hoteles/mcp-outbound";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../../support/pglite-fixture.ts";

let fixture: PgliteFixture;
let hotelId: string;

beforeAll(async () => {
  fixture = await createPgliteFixture();
  hotelId = fixture.seed.hotels[0]!.id;
}, 90_000);

afterAll(async () => {
  await destroyPgliteFixture(fixture);
});

beforeEach(async () => {
  await fixture.engine.admin.exec("truncate table public.hotel_pms_outbound_config;");
});

function sampleTask(overrides: Partial<OutboundTask> = {}): OutboundTask {
  return {
    idempotencyKey: "housekeeping_task:task-1",
    taskType: "housekeeping_task",
    taskId: "task-1",
    hotelId,
    title: "Limpieza habitación 101",
    priority: "media",
    roomCode: "101",
    status: "pendiente",
    occurredAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("OutboundTaskSyncGateway", () => {
  it("sin fila de configuración -- no llama al port, devuelve null", async () => {
    const port = new FakeOutboundTaskSyncAdapter();
    const gateway = new OutboundTaskSyncGateway(fixture.engine.admin, port);
    const result = await gateway.syncTask(sampleTask());
    expect(result).toBeNull();
    expect(port.pushed).toHaveLength(0);
  });

  it("con enabled=false -- no llama al port, devuelve null (BP-016)", async () => {
    await fixture.engine.admin.query(
      `insert into public.hotel_pms_outbound_config (hotel_id, tenant_id, webhook_url, webhook_secret, enabled)
       values ($1, $2, 'https://ejemplo.com/webhook', 'secreto-de-prueba-1234567890123', false);`,
      [hotelId, fixture.seed.orgId],
    );
    const port = new FakeOutboundTaskSyncAdapter();
    const gateway = new OutboundTaskSyncGateway(fixture.engine.admin, port);
    const result = await gateway.syncTask(sampleTask());
    expect(result).toBeNull();
    expect(port.pushed).toHaveLength(0);
  });

  it("habilitado pero sin este tipo de tarea en task_types -- no llama al port", async () => {
    await fixture.engine.admin.query(
      `insert into public.hotel_pms_outbound_config
         (hotel_id, tenant_id, webhook_url, webhook_secret, task_types, enabled)
       values ($1, $2, 'https://ejemplo.com/webhook', 'secreto-de-prueba-1234567890123',
               array['maintenance_ticket'], true);`,
      [hotelId, fixture.seed.orgId],
    );
    const port = new FakeOutboundTaskSyncAdapter();
    const gateway = new OutboundTaskSyncGateway(fixture.engine.admin, port);
    const result = await gateway.syncTask(sampleTask({ taskType: "housekeeping_task" }));
    expect(result).toBeNull();
    expect(port.pushed).toHaveLength(0);
  });

  it("habilitado con el tipo de tarea correcto -- llama al port con la URL/secreto de ESE hotel", async () => {
    await fixture.engine.admin.query(
      `insert into public.hotel_pms_outbound_config
         (hotel_id, tenant_id, webhook_url, webhook_secret, task_types, enabled)
       values ($1, $2, 'https://sistema-del-hotel.example/tareas', 'secreto-real-del-hotel-123456',
               array['housekeeping_task','maintenance_ticket','guest_ticket'], true);`,
      [hotelId, fixture.seed.orgId],
    );
    const port = new FakeOutboundTaskSyncAdapter();
    const gateway = new OutboundTaskSyncGateway(fixture.engine.admin, port);
    const task = sampleTask();
    const result = await gateway.syncTask(task);

    expect(result?.delivered).toBe(true);
    expect(port.pushed).toHaveLength(1);
    expect(port.pushed[0]!.destination).toEqual({
      url: "https://sistema-del-hotel.example/tareas",
      secret: "secreto-real-del-hotel-123456",
    });
    expect(port.pushed[0]!.task).toEqual(task);
  });

  it("un error del port (red/HTTP) se captura -- nunca lanza, devuelve delivered:false", async () => {
    await fixture.engine.admin.query(
      `insert into public.hotel_pms_outbound_config
         (hotel_id, tenant_id, webhook_url, webhook_secret, enabled)
       values ($1, $2, 'https://sistema-del-hotel.example/tareas', 'secreto-real-del-hotel-123456', true);`,
      [hotelId, fixture.seed.orgId],
    );
    const failingPort = {
      status: () => ({ provider: "webhook-outbound-generico", available: true, simulated: false }),
      pushTask: async () => {
        throw new Error("simulated network failure");
      },
    };
    const gateway = new OutboundTaskSyncGateway(fixture.engine.admin, failingPort);
    const result = await gateway.syncTask(sampleTask());
    expect(result).toEqual({ delivered: false, skipped: false, reason: "simulated network failure" });
  });
});
