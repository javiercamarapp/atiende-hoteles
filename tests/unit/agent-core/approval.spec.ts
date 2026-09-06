// Cola de aprobacion humana: solicitar, aprobar/rechazar con actor, expiracion,
// idempotencia por (tool, hash de input, hotel) y doble confirmacion para dinero (GOB-026).
// La bateria de comportamiento de negocio vive en tests/support/approvalQueueContract.ts,
// COMPARTIDA con tests/integration/agent-core/postgres-approval-queue.spec.ts (H6b) --
// aqui solo se registra que `InMemoryApprovalQueue` la cumple.
import { describe, expect, it } from "vitest";
import { InMemoryApprovalQueue, hashApprovalInput } from "@atiende-hoteles/agent-core";
import { runApprovalQueueContractSuite } from "../../support/approvalQueueContract.ts";

describe("hashApprovalInput", () => {
  it("es estable sin importar el orden de las llaves", () => {
    const a = hashApprovalInput({ x: 1, y: 2 });
    const b = hashApprovalInput({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("distingue inputs distintos", () => {
    expect(hashApprovalInput({ x: 1 })).not.toBe(hashApprovalInput({ x: 2 }));
  });
});

runApprovalQueueContractSuite("InMemoryApprovalQueue", (options) => new InMemoryApprovalQueue(options));
