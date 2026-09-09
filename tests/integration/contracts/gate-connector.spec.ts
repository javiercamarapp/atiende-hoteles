// REQ-QA-003 (BP-133, gate `connector`) · docs/ACEPTACION.md: "Toda tarea con gate
// `connector` pasa: contract tests contra fixture/sandbox, prueba de idempotencia (2
// webhooks iguales -> 1 efecto), prueba de conflicto 409, antes de mergear (verificado
// con un PR de ejemplo bloqueado hasta que las 3 pruebas pasan)."
//
// Esta es la suite que `scripts/checks/gate-por-tarea.ts` (REQ-AGT-019/GOB-048) exige
// como `requiredTests` para las categorías `connector-pms`/`connector-whatsapp`: toda
// tarea cuyos `paths` toquen `packages/mcp-servers/pms/` o `packages/mcp-servers/whatsapp/`
// y declare `gate: connector` queda bloqueada por ese check si este archivo no existe --
// y bloqueada por CI (`npm test`) si existe pero alguno de sus 3 grupos de prueba falla.
// Verificación literal del criterio ("PR de ejemplo bloqueado hasta que las 3 pruebas
// pasan"): ver `docs/logs/REQ-QA-003/` para la inyección en vivo que rompe cada uno de
// los 3 grupos por separado (idempotencia, conflicto, contrato) y confirma rojo -> verde.
//
// Los dos conectores externos reales del repo son PMS (Cloudbeds) y WhatsApp (Meta) --
// ambos ya exponen un adaptador Fake/Simulado etiquetado explícitamente como sandbox
// (`FakeCloudbedsAdapter`/`FakeWhatsappAdapter`, ADR-007) que reproduce la forma pública
// documentada del proveedor: ESE es el "fixture/sandbox" del criterio, nunca un mock que
// invente comportamiento. Los otros dos gates `connector` del catálogo (herramientas de
// agent-core, rutas de agentes de la API) son código interno propio sin un proveedor
// externo que pueda responder con un webhook o un 409 -- fuera del alcance literal de
// este criterio (que habla de "webhooks" y conflicto de escritura contra un proveedor),
// y ya cubiertos por su propio contract test (`tests/unit/agent-core/tool.spec.ts`,
// `tests/integration/api/agentes.spec.ts`).
import { describe, expect, it } from "vitest";
import {
  FakeCloudbedsAdapter,
  PmsReservation,
  PmsWebhookEvent,
  type ApplyReservationUpdateInput,
} from "@atiende-hoteles/mcp-pms";
import { FakeWhatsappAdapter, WhatsappWebhookEvent } from "@atiende-hoteles/mcp-whatsapp";
import { PortConflictError, PortNotFoundError, WebhookReplayError } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------------
// PMS (Cloudbeds) -- FakeCloudbedsAdapter como fixture/sandbox.
// ---------------------------------------------------------------------------------
describe("REQ-QA-003 · gate `connector` -- PMS (Cloudbeds)", () => {
  describe("1) contract test contra fixture/sandbox", () => {
    it("getReservation retorna una reserva que cumple el esquema público PmsReservation", async () => {
      const adapter = new FakeCloudbedsAdapter();
      const reservation = await adapter.getReservation("CB-RES-1001");
      expect(() => PmsReservation.parse(reservation)).not.toThrow();
    });

    it("verifyAndNormalizeWebhook normaliza un webhook firmado a un PmsWebhookEvent válido", async () => {
      const adapter = new FakeCloudbedsAdapter();
      const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
        event_id: "evt-contrato-1",
        event_type: "reservation.updated",
        reservation_id: "CB-RES-1001",
        occurred_at: "2026-09-08T12:00:00.000Z",
      });
      const event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      expect(() => PmsWebhookEvent.parse(event)).not.toThrow();
      expect(event.externalReservationId).toBe("CB-RES-1001");
    });
  });

  describe("2) idempotencia: 2 webhooks idénticos -> 1 efecto", () => {
    /** Simula el handler de webhook que un endpoint real invocaría: verifica/normaliza
     *  y, solo si tiene éxito, aplica el efecto (avanzar la reserva). Un replay nunca
     *  llega a `applyReservationUpdate` -- se cuenta cuántas veces el efecto ocurrió de
     *  verdad, no solo cuántas veces se invocó el webhook. */
    async function procesarWebhookDeCancelacion(
      adapter: FakeCloudbedsAdapter,
      rawBody: string,
      signature: string,
    ): Promise<{ aplicado: boolean; error?: unknown }> {
      let event;
      try {
        event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      } catch (error) {
        return { aplicado: false, error };
      }
      const actual = await adapter.getReservation(event.externalReservationId!);
      await adapter.applyReservationUpdate({
        externalReservationId: event.externalReservationId!,
        status: "cancelada",
        expectedVersion: actual.externalVersion,
        newVersion: `${actual.externalVersion}-cancelada`,
      });
      return { aplicado: true };
    }

    it("el mismo event_id procesado 2 veces produce 1 solo efecto: la 2a es rechazada como replay ANTES de aplicarse", async () => {
      const adapter = new FakeCloudbedsAdapter();
      const before = await adapter.getReservation("CB-RES-1001");
      const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
        event_id: "evt-idempotencia-1",
        event_type: "reservation.canceled",
        reservation_id: "CB-RES-1001",
        occurred_at: "2026-09-08T12:00:00.000Z",
      });

      const primero = await procesarWebhookDeCancelacion(adapter, rawBody, signature);
      const segundo = await procesarWebhookDeCancelacion(adapter, rawBody, signature);

      expect(primero.aplicado).toBe(true);
      expect(segundo.aplicado).toBe(false);
      expect(segundo.error).toBeInstanceOf(WebhookReplayError);

      // El efecto (avance de versión/estado) ocurrió exactamente 1 vez: una 2a
      // aplicación habría vuelto a mutar `externalVersion` a partir de la ya avanzada.
      const after = await adapter.getReservation("CB-RES-1001");
      expect(after.status).toBe("cancelada");
      expect(after.externalVersion).toBe(`${before.externalVersion}-cancelada`);
    });
  });

  describe("3) conflicto de escritura -> 409 (PortConflictError)", () => {
    it("applyReservationUpdate con `expectedVersion` desactualizada lanza PortConflictError y NO muta el registro", async () => {
      const adapter = new FakeCloudbedsAdapter();
      const before = await adapter.getReservation("CB-RES-1001");
      const input: ApplyReservationUpdateInput = {
        externalReservationId: "CB-RES-1001",
        status: "cancelada",
        expectedVersion: "version-obsoleta-que-ya-no-existe",
        newVersion: "v-nueva",
      };

      await expect(adapter.applyReservationUpdate(input)).rejects.toMatchObject({
        code: "port_conflict",
        expectedVersion: "version-obsoleta-que-ya-no-existe",
        actualVersion: before.externalVersion,
      });
      const err = await adapter.applyReservationUpdate(input).catch((e) => e as PortConflictError);
      expect(err).toBeInstanceOf(PortConflictError);

      // Sin efecto secundario: el registro sigue exactamente como antes del intento.
      const after = await adapter.getReservation("CB-RES-1001");
      expect(after).toEqual(before);
    });

    it("applyReservationUpdate con `expectedVersion` vigente SÍ aplica y avanza la versión (contraste del camino feliz)", async () => {
      const adapter = new FakeCloudbedsAdapter();
      const before = await adapter.getReservation("CB-RES-1002");
      const updated = await adapter.applyReservationUpdate({
        externalReservationId: "CB-RES-1002",
        status: "en_estancia",
        expectedVersion: before.externalVersion,
        newVersion: "v4",
      });
      expect(updated.status).toBe("en_estancia");
      expect(updated.externalVersion).toBe("v4");
    });

    it("applyReservationUpdate contra una reserva inexistente lanza PortNotFoundError, no un conflicto silencioso", async () => {
      const adapter = new FakeCloudbedsAdapter();
      await expect(
        adapter.applyReservationUpdate({
          externalReservationId: "CB-RES-NO-EXISTE",
          status: "cancelada",
          expectedVersion: "v1",
          newVersion: "v2",
        }),
      ).rejects.toBeInstanceOf(PortNotFoundError);
    });
  });
});

// ---------------------------------------------------------------------------------
// WhatsApp (Meta) -- FakeWhatsappAdapter como fixture/sandbox.
// ---------------------------------------------------------------------------------
describe("REQ-QA-003 · gate `connector` -- WhatsApp (Meta)", () => {
  describe("1) contract test contra fixture/sandbox", () => {
    it("verifyAndNormalizeWebhook normaliza un webhook firmado a un WhatsappWebhookEvent válido", async () => {
      const adapter = new FakeWhatsappAdapter();
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture({
        event_id: "wa-evt-contrato-1",
        type: "message.received",
        from: "+5219981234567",
        text: "hola",
        occurred_at: "2026-09-08T12:00:00.000Z",
      });
      const event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      expect(() => WhatsappWebhookEvent.parse(event)).not.toThrow();
      expect(event.textBody).toBe("hola");
    });
  });

  describe("2) idempotencia: 2 webhooks idénticos -> 1 efecto", () => {
    it("el mismo event_id de un clic de botón procesado 2 veces solo cuenta 1 vez: la 2a se rechaza como replay", async () => {
      const adapter = new FakeWhatsappAdapter();
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture({
        event_id: "wa-evt-idempotencia-1",
        type: "interactive.button_clicked",
        from: "+5219981234567",
        button_id: "aprobar:11111111-1111-1111-1111-111111111111",
        occurred_at: "2026-09-08T12:00:00.000Z",
      });

      let vecesAplicado = 0;
      async function procesarClicDeBoton(): Promise<{ aplicado: boolean; error?: unknown }> {
        try {
          await adapter.verifyAndNormalizeWebhook(rawBody, signature);
        } catch (error) {
          return { aplicado: false, error };
        }
        vecesAplicado += 1; // el "efecto" real (ejecutar la aprobación) solo corre aquí.
        return { aplicado: true };
      }

      const primero = await procesarClicDeBoton();
      const segundo = await procesarClicDeBoton();

      expect(primero.aplicado).toBe(true);
      expect(segundo.aplicado).toBe(false);
      expect(segundo.error).toBeInstanceOf(WebhookReplayError);
      expect(vecesAplicado).toBe(1);
    });
  });

  // 3) Conflicto 409: WhatsApp/Meta no expone concurrencia optimista de escritura sobre
  // un recurso versionado (a diferencia de una reserva de PMS, un mensaje entrante no se
  // "actualiza" -- REQ-QA-003 habla literalmente de webhooks + conflicto de escritura
  // contra un proveedor). El conector PMS de arriba cubre el caso real y completo del
  // criterio; documentado aquí en vez de fabricar un conflicto que este proveedor no
  // tiene, para no fingir cobertura donde no aplica (mismo criterio de honestidad que
  // `docs/TRAZABILIDAD.md`).
});
