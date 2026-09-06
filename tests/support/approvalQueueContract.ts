// H6b · Suite de contrato COMPARTIDA para cualquier implementacion de `ApprovalQueue`
// (InMemoryApprovalQueue de H6a, PostgresApprovalQueue de H6b): mismas 13 aserciones de
// negocio contra cualquier backend, para que "PostgresApprovalQueue cumple el MISMO
// contrato que la de memoria" sea una propiedad VERIFICADA, no solo declarada. Ver
// tests/unit/agent-core/approval.spec.ts (backend en memoria) y
// tests/integration/agent-core/postgres-approval-queue.spec.ts (backend Postgres real).
import { describe, expect, it } from "vitest";
import { ApprovalError, type ApprovalQueue } from "@atiende-hoteles/agent-core";

export interface ApprovalQueueContractIds {
  readonly orgId: string;
  readonly hotelId: string;
  /** Un segundo hotel VALIDO (mismo org u otro) para la prueba de aislamiento entre
   * hoteles -- debe existir de verdad contra un backend con FK reales (Postgres). */
  readonly hotelIdB: string;
}

export interface ApprovalQueueContractOptions {
  readonly defaultTtlMs?: number;
}

const DEFAULT_IDS: ApprovalQueueContractIds = { orgId: "org-1", hotelId: "hotel-1", hotelIdB: "hotel-A" };

export function runApprovalQueueContractSuite(
  label: string,
  createQueue: (options?: ApprovalQueueContractOptions) => ApprovalQueue,
  /** Funcion (no valor) para poder resolver ids reales despues de un `beforeAll` (p.ej.
   * `seedDev`) -- se evalua DENTRO de cada `it`, nunca al registrar la suite. */
  getIds: () => ApprovalQueueContractIds = () => DEFAULT_IDS,
): void {
  describe(`${label} (contrato ApprovalQueue)`, () => {
    it("crea una solicitud pendiente con 1 confirmacion requerida para escritura no monetaria", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "publicar_resena_respuesta",
        input: {},
        orgId,
        hotelId,
        requestedBy: "agent:anfitrion",
        isMoney: false,
        textoMostrado: "responder resena",
      });
      expect(req.status).toBe("pendiente");
      expect(req.requiredConfirmations).toBe(1);
    });

    it("exige 2 confirmaciones para una accion de dinero", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: { montoMxn: 1500 },
        orgId,
        hotelId,
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
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: {},
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar",
      });
      await expect(
        queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar" }),
      ).rejects.toThrow(ApprovalError);
    });

    it("rechaza que el mismo actor confirme dos veces una aprobacion de dinero", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: {},
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar",
      });
      await queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" });
      await expect(
        queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" }),
      ).rejects.toThrow(ApprovalError);
    });

    it(
      "rechaza la segunda confirmacion de dinero si declara el MISMO rol con un actor distinto " +
        "(aud-1 agentico.md MEDIO #6: dos alias del mismo rol no son dos personas)",
      async () => {
        const { orgId, hotelId } = getIds();
        const queue = createQueue();
        const req = await queue.request({
          toolName: "cobrar_folio",
          input: {},
          orgId,
          hotelId,
          requestedBy: "agent:contralor",
          isMoney: true,
          textoMostrado: "cobrar",
        });
        await queue.decide({ approvalId: req.id, actor: "gerente-1", role: "gerente", decision: "aprobar", textoExacto: "cobrar" });
        await expect(
          queue.decide({
            approvalId: req.id,
            actor: "gerente-1-movil",
            role: "gerente",
            decision: "aprobar",
            textoExacto: "cobrar",
          }),
        ).rejects.toThrow(ApprovalError);
      },
    );

    it("rechazar deja la solicitud en estado rechazada", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "cambiar_tarifa",
        input: {},
        orgId,
        hotelId,
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

    it(
      "una solicitud RECHAZADA se reusa (misma decision humana): un reintento identico del modelo " +
        "obtiene el mismo id, con status 'rechazada' visible, nunca una pendiente fantasma",
      async () => {
        const { orgId, hotelId } = getIds();
        const queue = createQueue();
        const params = {
          toolName: "cambiar_tarifa",
          input: {},
          orgId,
          hotelId,
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

        await expect(
          queue.decide({ approvalId: second.id, actor: "gerente-2", decision: "aprobar", textoExacto: "x" }),
        ).rejects.toThrow(ApprovalError);
      },
    );

    it("es idempotente: la misma tool+input+hotel+ambito reusa la solicitud pendiente", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const input = { montoMxn: 500 };
      const first = await queue.request({
        toolName: "cobrar_folio",
        input,
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar 500",
      });
      const second = await queue.request({
        toolName: "cobrar_folio",
        input,
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar 500",
      });
      expect(second.id).toBe(first.id);
    });

    it(
      "NO reusa la solicitud entre huespedes/folios distintos aunque tool+input+hotel coincidan " +
        "(aud-1 tool-calling.md CRITICO #1: una aprobacion de un huesped no debe autorizar a otro)",
      async () => {
        const { orgId, hotelId } = getIds();
        const queue = createQueue();
        const reqGuestA = await queue.request({
          toolName: "cerrar_folio",
          input: {},
          orgId,
          hotelId,
          requestedBy: "agent:recepcionista:guest-A-folio-100",
          isMoney: true,
          textoMostrado: "cerrar folio de A ($1,500 MXN)",
        });
        const reqGuestB = await queue.request({
          toolName: "cerrar_folio",
          input: {},
          orgId,
          hotelId,
          requestedBy: "agent:recepcionista:guest-B-folio-200",
          isMoney: true,
          textoMostrado: "cerrar folio de B ($9,800 MXN)",
        });

        expect(reqGuestB.id).not.toBe(reqGuestA.id);

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
        expect(stillB?.status).toBe("pendiente");
      },
    );

    it("no reusa la solicitud entre hoteles distintos (misma tool+input)", async () => {
      const { orgId, hotelId, hotelIdB } = getIds();
      const queue = createQueue();
      const input = { montoMxn: 500 };
      const a = await queue.request({
        toolName: "cobrar_folio",
        input,
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar 500",
      });
      const b = await queue.request({
        toolName: "cobrar_folio",
        input,
        orgId,
        hotelId: hotelIdB,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar 500",
      });
      expect(a.id).not.toBe(b.id);
    });

    it("expira una solicitud pendiente pasado su ttl", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue({ defaultTtlMs: 1000 });
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: {},
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: true,
        textoMostrado: "cobrar",
      });
      const later = new Date(Date.parse(req.requestedAt) + 5000);
      const expiredCount = await queue.expirePending(later);
      expect(expiredCount).toBeGreaterThanOrEqual(1);
      const fetched = await queue.get(req.id);
      expect(fetched?.status).toBe("expirada");
    });

    it("decide() rechaza una solicitud expirada", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue({ defaultTtlMs: 1000 });
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: {},
        orgId,
        hotelId,
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
      const queue = createQueue();
      await expect(
        queue.decide({ approvalId: "00000000-0000-0000-0000-000000000000", actor: "x", decision: "aprobar", textoExacto: "x" }),
      ).rejects.toThrow(ApprovalError);
    });

    // A4 (auditoria-2 agentico/tool-calling): una aprobacion "aprobada" se consume UNA
    // sola vez -- markExecuted() es la reclamacion atomica que evita que un reintento
    // del modelo, o una segunda ejecucion fuera de banda, vuelva a correr la tool sin
    // una decision humana nueva.
    it("markExecuted(): la primera llamada devuelve true, cualquier llamada posterior devuelve false (idempotencia del EFECTO, no solo de la solicitud)", async () => {
      const { orgId, hotelId } = getIds();
      const queue = createQueue();
      const req = await queue.request({
        toolName: "cobrar_folio",
        input: {},
        orgId,
        hotelId,
        requestedBy: "agent:contralor",
        isMoney: false,
        textoMostrado: "cobrar",
      });
      const decided = await queue.decide({ approvalId: req.id, actor: "gerente-1", decision: "aprobar", textoExacto: "cobrar" });
      expect(decided.status).toBe("aprobada");
      expect(decided.executedAt).toBeUndefined();

      const primera = await queue.markExecuted(req.id);
      expect(primera).toBe(true);
      const segunda = await queue.markExecuted(req.id);
      expect(segunda).toBe(false);
      const tercera = await queue.markExecuted(req.id);
      expect(tercera).toBe(false);

      const fetched = await queue.get(req.id);
      expect(fetched?.executedAt).toBeTruthy();
    });

    it("markExecuted() sobre un id inexistente devuelve false, nunca lanza", async () => {
      const queue = createQueue();
      await expect(queue.markExecuted("00000000-0000-0000-0000-000000000000")).resolves.toBe(false);
    });
  });
}
