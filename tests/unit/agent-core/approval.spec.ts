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
      role: "gerente",
      decision: "aprobar",
      textoExacto: "cobrar folio 1500 MXN",
    });
    expect(primera.status).toBe("pendiente");

    const segunda = await queue.decide({
      approvalId: req.id,
      actor: "director-1",
      role: "director",
      decision: "aprobar",
      textoExacto: "cobrar folio 1500 MXN",
    });
    expect(segunda.status).toBe("aprobada");
    expect(segunda.confirmations).toHaveLength(2);
  });

  it("aprobar una solicitud de dinero sin declarar rol lanza (GOB-026 exige rol del aprobador)", async () => {
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
    await expect(
      queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar" }),
    ).rejects.toThrow(ApprovalError);
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
    await queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" });
    await expect(
      queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" }),
    ).rejects.toThrow(ApprovalError);
  });

  it("rechaza la segunda confirmacion de dinero si declara el MISMO rol con un actor distinto " +
    "(aud-1 agentico.md MEDIO #6: dos alias del mismo rol no son dos personas)", async () => {
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
    await queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" });
    // "gerente-1-movil" es un actor DISTINTO (otra sesion/alias), pero declara el MISMO rol:
    // no debe contar como la segunda confirmacion independiente que exige GOB-026.
    await expect(
      queue.decide({
        approvalId: req.id,
        actor: "gerente-1-movil",
        role: "gerente",
        decision: "aprobar",
        textoExacto: "cobrar",
      }),
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

  it("una solicitud RECHAZADA se reusa (misma decision humana): un reintento identico del " +
    "modelo obtiene el mismo id, con status 'rechazada' visible, nunca una pendiente " +
    "fantasma (aud-1 tool-calling.md ALTO #4 -- ver AgentRunner.run() para el reporte " +
    "terminal explicito)", async () => {
    const queue = new InMemoryApprovalQueue();
    const params = {
      toolName: "cambiar_tarifa",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:revenue",
      isMoney: false,
      textoMostrado: "subir tarifa 10%",
    } as const;
    const first = await queue.request(params);
    const rejected = await queue.decide({
      approvalId: first.id,
      actor: "gerente-1",
      decision: "rechazar",
      textoExacto: "subir tarifa 10%",
    });
    expect(rejected.status).toBe("rechazada");

    const second = await queue.request(params);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("rechazada");

    // decide() sigue rechazando cualquier intento de reabrir una decision ya cerrada.
    await expect(
      queue.decide({ approvalId: second.id, actor: "gerente-2", decision: "aprobar", textoExacto: "x" }),
    ).rejects.toThrow(ApprovalError);
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

  it("NO reusa la solicitud entre huespedes/folios distintos aunque tool+input+hotel coincidan " +
    "(aud-1 tool-calling.md CRITICO #1: una aprobacion de un huesped no debe autorizar a otro)", async () => {
    const queue = new InMemoryApprovalQueue();
    // Patron Likida properties:{} (ADR-006): el input de "cerrar_folio" es SIEMPRE {} --
    // el folio/monto real depende de la conversacion en curso, identificada por
    // requestedBy (agent:<nombre>:<actorId>), nunca del input.
    const reqGuestA = await queue.request({
      toolName: "cerrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:recepcionista:guest-A-folio-100",
      isMoney: true,
      textoMostrado: "cerrar folio de A ($1,500 MXN)",
    });
    const reqGuestB = await queue.request({
      toolName: "cerrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:recepcionista:guest-B-folio-200",
      isMoney: true,
      textoMostrado: "cerrar folio de B ($9,800 MXN)",
    });

    expect(reqGuestB.id).not.toBe(reqGuestA.id);

    // El gerente aprueba (2 confirmaciones) SOLO la solicitud de A.
    await queue.decide({
      approvalId: reqGuestA.id,
      actor: "gerente-1",
      role: "gerente",
      decision: "aprobar",
      textoExacto: reqGuestA.textoMostrado,
    });
    await queue.decide({
      approvalId: reqGuestA.id,
      actor: "director-1",
      role: "director",
      decision: "aprobar",
      textoExacto: reqGuestA.textoMostrado,
    });

    const decidedA = await queue.get(reqGuestA.id);
    const stillB = await queue.get(reqGuestB.id);
    expect(decidedA?.status).toBe("aprobada");
    // La solicitud de B NUNCA debe quedar aprobada de rebote.
    expect(stillB?.status).toBe("pendiente");
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
