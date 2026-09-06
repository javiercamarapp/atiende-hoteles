// Cola de aprobacion humana: solicitar, aprobar/rechazar con actor, expiracion,
// idempotencia por (tool, hash de input, hotel) y doble confirmacion para dinero (GOB-026).
import { describe, expect, it } from "vitest";
import { ApprovalError, InMemoryApprovalQueue, hashApprovalInput } from "@atiende-hoteles/agent-core";

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

describe("InMemoryApprovalQueue", () => {
  it("crea una solicitud pendiente con 1 confirmacion requerida para escritura no monetaria", async () => {
    const queue = new InMemoryApprovalQueue();
    const req = await queue.request({
      toolName: "publicar_resena_respuesta",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:anfitrion",
      isMoney: false,
      textoMostrado: "responder resena",
    });
    expect(req.status).toBe("pendiente");
    expect(req.requiredConfirmations).toBe(1);
  });

  it("exige 2 confirmaciones para una accion de dinero", async () => {
    const queue = new InMemoryApprovalQueue();
    const req = await queue.request({
      toolName: "cobrar_folio",
      input: { montoMxn: 1500 },
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar folio 1500 MXN",
    });
    expect(req.requiredConfirmations).toBe(2);

    const primera = await queue.decide({
      approvalId: req.id,
      actor: "gerente-1",
      decision: "aprobar",
      textoExacto: "cobrar folio 1500 MXN",
    });
    expect(primera.status).toBe("pendiente");

    const segunda = await queue.decide({
      approvalId: req.id,
      actor: "director-1",
      decision: "aprobar",
      textoExacto: "cobrar folio 1500 MXN",
    });
    expect(segunda.status).toBe("aprobada");
    expect(segunda.confirmations).toHaveLength(2);
  });

  it("rechaza que el mismo actor confirme dos veces una aprobacion de dinero", async () => {
    const queue = new InMemoryApprovalQueue();
    const req = await queue.request({
      toolName: "cobrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar",
    });
    await queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar" });
    await expect(
      queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar" }),
    ).rejects.toThrow(ApprovalError);
  });

  it("rechazar deja la solicitud en estado rechazada", async () => {
    const queue = new InMemoryApprovalQueue();
    const req = await queue.request({
      toolName: "cambiar_tarifa",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:revenue",
      isMoney: false,
      textoMostrado: "subir tarifa 10%",
    });
    const decided = await queue.decide({
      approvalId: req.id,
      actor: "gerente-1",
      decision: "rechazar",
      textoExacto: "subir tarifa 10%",
    });
    expect(decided.status).toBe("rechazada");
  });

  it("es idempotente: la misma tool+input+hotel reusa la solicitud pendiente", async () => {
    const queue = new InMemoryApprovalQueue();
    const input = { montoMxn: 500 };
    const first = await queue.request({
      toolName: "cobrar_folio",
      input,
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar 500",
    });
    const second = await queue.request({
      toolName: "cobrar_folio",
      input,
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar 500",
    });
    expect(second.id).toBe(first.id);
  });

  it("no reusa la solicitud entre hoteles distintos (misma tool+input)", async () => {
    const queue = new InMemoryApprovalQueue();
    const input = { montoMxn: 500 };
    const a = await queue.request({
      toolName: "cobrar_folio",
      input,
      orgId: "org-1",
      hotelId: "hotel-A",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar 500",
    });
    const b = await queue.request({
      toolName: "cobrar_folio",
      input,
      orgId: "org-1",
      hotelId: "hotel-B",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar 500",
    });
    expect(a.id).not.toBe(b.id);
  });

  it("expira una solicitud pendiente pasado su ttl", async () => {
    const queue = new InMemoryApprovalQueue({ defaultTtlMs: 1000 });
    const req = await queue.request({
      toolName: "cobrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: true,
      textoMostrado: "cobrar",
    });
    const later = new Date(Date.parse(req.requestedAt) + 5000);
    const expiredCount = await queue.expirePending(later);
    expect(expiredCount).toBe(1);
    const fetched = await queue.get(req.id);
    expect(fetched?.status).toBe("expirada");
  });

  it("decide() rechaza una solicitud expirada", async () => {
    const queue = new InMemoryApprovalQueue({ defaultTtlMs: 1000 });
    const req = await queue.request({
      toolName: "cobrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:contralor",
      isMoney: false,
      textoMostrado: "cobrar",
    });
    const later = new Date(Date.parse(req.requestedAt) + 5000);
    await expect(
      queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar", now: later }),
    ).rejects.toThrow(ApprovalError);
  });

  it("decide() lanza sobre un id inexistente", async () => {
    const queue = new InMemoryApprovalQueue();
    await expect(
      queue.decide({ approvalId: "no-existe", actor: "x", decision: "aprobar", textoExacto: "x" }),
    ).rejects.toThrow(ApprovalError);
  });
});
