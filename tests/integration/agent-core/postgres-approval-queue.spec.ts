// H6b · `PostgresApprovalQueue` corre EXACTAMENTE la misma bateria de contrato que
// `InMemoryApprovalQueue` (tests/unit/agent-core/approval.spec.ts), contra un
// `embedded-postgres` real -- persistencia real via `agent_approval`/
// `agent_approval_confirmation` (packages/db/migrations/0042_agent_approval.sql). Ademas:
// (1) sobrevive un reinicio real del PROCESO (se detiene y reabre `embedded-postgres`
// sobre el MISMO data dir, con una instancia nueva de `PostgresApprovalQueue`, sin ningun
// estado en memoria compartido entre el "antes" y el "despues"); (2) la doble
// confirmacion de dinero con DOS ACTORES/ROLES reales via `withAppSession` (RLS real,
// staff sembrado por seedDev).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresApprovalQueue } from "@atiende-hoteles/agent-core";
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";
import { runApprovalQueueContractSuite } from "../../support/approvalQueueContract.ts";

let engine: EmbeddedPostgresEngine;
let seed: SeedResult;

beforeAll(async () => {
  engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  seed = await seedDev(engine.admin);
});

afterAll(async () => {
  await engine.stop();
});

// La suite de contrato ejercita muchas combinaciones de (tool, input, requestedBy) sobre
// el MISMO hotel; sin aislar cada `it` la reutilizacion por idempotencia de una prueba
// contaminaria la siguiente (a diferencia de InMemoryApprovalQueue, que crea un Map vacio
// por prueba). Se trunca entre pruebas para que cada `it` vea una tabla vacia, igual que
// InMemoryApprovalQueue ve un Map vacio.
afterEach(async () => {
  await engine.admin.exec(
    "truncate table public.agent_approval_confirmation, public.agent_approval restart identity cascade;",
  );
});

runApprovalQueueContractSuite(
  "PostgresApprovalQueue",
  (options) => new PostgresApprovalQueue(engine.admin, { ...options, moneyRequiredConfirmations: 2 }),
  // Funcion (no valor): se evalua DENTRO de cada `it`, despues de que `beforeAll` corrio
  // `seedDev` -- org/hoteles reales con FK validas (Postgres exige uuid existente).
  () => ({ orgId: seed.orgId, hotelId: seed.hotels[0]!.id, hotelIdB: seed.hotels[1]!.id }),
);

describe("PostgresApprovalQueue (persistencia real)", () => {
  it("sobrevive un reinicio del PROCESO: el estado vive en Postgres, no en el objeto JS", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "atiende-hoteles-approval-restart-"));
    const port = 54_329 + Math.floor(Math.random() * 500);
    let restartEngine = await openEmbeddedPostgres({ databaseDir, port, persistent: true });
    try {
      await applyMigrations(restartEngine.admin);
      const restartSeed = await seedDev(restartEngine.admin);
      const hotelId = restartSeed.hotels[0]!.id;

      const before = new PostgresApprovalQueue(restartEngine.admin);
      const created = await before.request({
        toolName: "autorizar_gasto_mantenimiento",
        input: { ticketId: randomUUID(), actualCost: 4500 },
        orgId: restartSeed.orgId,
        hotelId,
        requestedBy: "agent:mantenimiento:ticket-1",
        isMoney: true,
        textoMostrado: "autorizar 4500 MXN",
      });
      expect(created.status).toBe("pendiente");

      // Simula el "antes" del reinicio: se detiene POR COMPLETO el proceso de Postgres
      // (no solo se cierra la conexion) y se descarta cualquier objeto JS en memoria --
      // `before`/`restartEngine` de aqui en adelante ya no se usan.
      await restartEngine.stop();

      // "Reinicio del proceso": se reabre embedded-postgres sobre el MISMO data dir
      // (persistent:true) con una instancia COMPLETAMENTE NUEVA de PostgresApprovalQueue
      // -- ningun Map/objeto sobrevive de la corrida anterior, solo lo que quedo en disco.
      restartEngine = await openEmbeddedPostgres({ databaseDir, port, persistent: true });
      const after = new PostgresApprovalQueue(restartEngine.admin);
      const fetched = await after.get(created.id);
      expect(fetched?.status).toBe("pendiente");
      expect(fetched?.textoMostrado).toBe("autorizar 4500 MXN");
      expect(fetched?.requiredConfirmations).toBe(2);

      // Y sigue siendo operable de verdad tras el reinicio (no solo legible).
      const decided = await after.decide({
        approvalId: created.id,
        actor: "tecnico-1",
        role: "maintenance",
        decision: "aprobar",
        textoExacto: "autorizar 4500 MXN",
      });
      expect(decided.status).toBe("pendiente"); // falta la 2a confirmacion (isMoney)
    } finally {
      await restartEngine.stop();
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  it("doble confirmacion de dinero con DOS actores/roles reales via sesiones RLS distintas (owner + gm)", async () => {
    const hotel = seed.hotels[0]!;
    const owner = hotel.staff.find((s) => s.role === "owner")!;
    const gm = hotel.staff.find((s) => s.role === "gm")!;

    const queue = new PostgresApprovalQueue(engine.admin);
    const created = await queue.request({
      toolName: "autorizar_gasto_mantenimiento",
      input: { ticketId: randomUUID(), actualCost: 7200 },
      orgId: seed.orgId,
      hotelId: hotel.id,
      requestedBy: "agent:mantenimiento:ticket-doble-actor",
      isMoney: true,
      textoMostrado: "autorizar 7200 MXN",
    });

    // Primer aprobador (owner) via una sesion RLS real -- la policy
    // "agent_approval_manager_update" (0042) exige rol owner/gm, se ejercita de verdad.
    await engine.withAppSession({ userId: owner.id }, async (session) => {
      const queueAsOwner = new PostgresApprovalQueue(session);
      const decided = await queueAsOwner.decide({
        approvalId: created.id,
        actor: owner.id,
        role: "owner",
        decision: "aprobar",
        textoExacto: "autorizar 7200 MXN",
      });
      expect(decided.status).toBe("pendiente");
    });

    // Segundo aprobador (gm), OTRA conexion/sesion real -> completa la doble confirmacion.
    await engine.withAppSession({ userId: gm.id }, async (session) => {
      const queueAsGm = new PostgresApprovalQueue(session);
      const decided = await queueAsGm.decide({
        approvalId: created.id,
        actor: gm.id,
        role: "gm",
        decision: "aprobar",
        textoExacto: "autorizar 7200 MXN",
      });
      expect(decided.status).toBe("aprobada");
      expect(decided.confirmations).toHaveLength(2);
    });
  });
});
