// Prueba de contrato de CfdiPort + mitigación de doble-PAC (REQ-INT-005): "PAC primario
// simulado caído -> conmutación al PAC secundario sin duplicar el timbrado".
import { describe, expect, it } from "vitest";
import {
  FakeFinkokAdapter,
  FakeSwSapienAdapter,
  DualPacCfdiPort,
  FinkokAdapter,
  SwSapienAdapter,
  mapPacStatusToDomain,
  CfdiFolioConflictError,
  type TimbrarInput,
} from "@atiende-hoteles/mcp-cfdi";
import { PortUnavailableError, WebhookSignatureError, WebhookReplayError } from "@atiende-hoteles/mcp-shared";

function buildTimbrarInput(overrides: Partial<TimbrarInput> = {}): TimbrarInput {
  return {
    folio: "FOLIO-1001",
    rfcEmisor: "HAO010101AAA",
    rfcReceptor: "XAXX010101000",
    subtotal: 1000,
    iva: 160,
    impuestosLocales: { ishTasa: 0.03, ishMonto: 30 },
    total: 1190,
    moneda: "MXN",
    usoCfdi: "G03",
    metodoPago: "PUE",
    ...overrides,
  };
}

describe("mapPacStatusToDomain", () => {
  it("mapea los 5 estados nativos de ejemplo a un estado de dominio válido", () => {
    expect(mapPacStatusToDomain("stamped")).toBe("timbrado");
    expect(mapPacStatusToDomain("active")).toBe("timbrado");
    expect(mapPacStatusToDomain("cancellation_pending")).toBe("en_proceso_cancelacion");
    expect(mapPacStatusToDomain("canceled")).toBe("cancelado");
    expect(mapPacStatusToDomain("rejected")).toBe("rechazado");
  });
});

describe("FakeFinkokAdapter -- timbrado idempotente", () => {
  it("timbrar dos veces el mismo folio con los mismos datos retorna el mismo UUID", async () => {
    const pac = new FakeFinkokAdapter();
    const input = buildTimbrarInput();
    const first = await pac.timbrar(input);
    const second = await pac.timbrar(input);
    expect(second.uuid).toBe(first.uuid);
  });

  it("timbrar el mismo folio con datos DISTINTOS lanza CfdiFolioConflictError", async () => {
    const pac = new FakeFinkokAdapter();
    await pac.timbrar(buildTimbrarInput());
    await expect(pac.timbrar(buildTimbrarInput({ total: 9999 }))).rejects.toBeInstanceOf(CfdiFolioConflictError);
  });

  it("cancelar es idempotente por idempotencyKey", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(buildTimbrarInput());
    const input = { uuid: timbrado.uuid, motivo: "02" as const, idempotencyKey: "cancel-1" };
    const first = await pac.cancelar(input);
    const second = await pac.cancelar(input);
    expect(second.status).toBe("cancelado");
    expect(first.fechaSolicitud).toBe(second.fechaSolicitud);
  });

  // REQ-QA-010: `consultarEstado` es capability declarada de `CfdiPort` sin contract
  // test hasta este cambio -- la auditoría estática de
  // scripts/checks/registro-conectores-pms.ts la reportaba como hallazgo bloqueante
  // (ver docs/logs/REQ-QA-010/). Prueba el round-trip real: timbrado -> "timbrado",
  // cancelado -> "cancelado", y un UUID que el PAC nunca timbró lanza en vez de
  // inventar un estado.
  it("consultarEstado refleja el estado real: timbrado tras timbrar, cancelado tras cancelar", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(buildTimbrarInput());
    expect(await pac.consultarEstado(timbrado.uuid)).toBe("timbrado");

    await pac.cancelar({ uuid: timbrado.uuid, motivo: "02", idempotencyKey: "consulta-cancel-1" });
    expect(await pac.consultarEstado(timbrado.uuid)).toBe("cancelado");
  });

  it("consultarEstado de un UUID que este PAC nunca timbró lanza, nunca inventa un estado", async () => {
    const pac = new FakeFinkokAdapter();
    await expect(pac.consultarEstado("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/UUID desconocido/);
  });
});

describe("DualPacCfdiPort -- conmutación primario caído -> secundario sin duplicar", () => {
  it("si el PAC primario está disponible, lo usa (no toca el secundario)", async () => {
    const primary = new FakeFinkokAdapter();
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(buildTimbrarInput());
    expect(timbrado.pac).toBe("finkok");
    expect(dual.usedSecondaryFor("FOLIO-1001")).toBe(false);
  });

  it("si el PAC primario está 'caído', conmuta al secundario y timbra UNA sola vez", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(buildTimbrarInput());
    expect(timbrado.pac).toBe("sw-sapien");
    expect(dual.usedSecondaryFor("FOLIO-1001")).toBe(true);
  });

  it("una segunda llamada con el mismo folio tras la conmutación NO vuelve a timbrar (ni siquiera intenta el primario)", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const first = await dual.timbrar(buildTimbrarInput());
    primary.down = false; // aunque el primario "se recupere", el folio ya está resuelto
    const second = await dual.timbrar(buildTimbrarInput());
    expect(second.uuid).toBe(first.uuid);
    expect(second.pac).toBe("sw-sapien"); // sigue siendo el mismo CFDI, no uno nuevo del primario
  });

  it("si AMBOS PAC fallan, lanza un error agregado (nunca inventa un timbrado)", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    secondary.down = true;
    const dual = new DualPacCfdiPort(primary, secondary);
    await expect(dual.timbrar(buildTimbrarInput())).rejects.toThrow();
  });
});

describe("adaptadores reales (Finkok/SW) sin credenciales -- declaración honesta", () => {
  it("FinkokAdapter.status() reporta [PENDIENTE DE CREDENCIALES]", () => {
    const finkok = new FinkokAdapter();
    if (finkok.status().available) return;
    expect(finkok.status().reason).toMatch(/PENDIENTE DE CREDENCIALES/);
  });

  it("SwSapienAdapter.timbrar() sin CSD lanza PortUnavailableError", async () => {
    const sw = new SwSapienAdapter();
    if (sw.status().available) return;
    await expect(sw.timbrar(buildTimbrarInput())).rejects.toBeInstanceOf(PortUnavailableError);
  });
});

describe("webhook de CFDI -- firma HMAC + replay", () => {
  it("firma válida se acepta y normaliza el evento de cancelación", async () => {
    const pac = new FakeFinkokAdapter();
    const { rawBody, signature } = pac.signWebhookFixture({
      event_id: "evt-cfdi-1",
      type: "cfdi.cancelado",
      uuid: "11111111-1111-1111-1111-111111111111",
      status: "cancelado",
      occurred_at: new Date().toISOString(),
    });
    const event = await pac.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.eventId).toBe("evt-cfdi-1");
  });

  it("firma inválida se rechaza", async () => {
    const pac = new FakeSwSapienAdapter();
    const { rawBody } = pac.signWebhookFixture({
      event_id: "evt-cfdi-2",
      type: "cfdi.timbrado_confirmado",
      uuid: "22222222-2222-2222-2222-222222222222",
      status: "timbrado",
      occurred_at: new Date().toISOString(),
    });
    await expect(pac.verifyAndNormalizeWebhook(rawBody, "sha256=invalida")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("un event_id repetido (replay) se rechaza en el segundo intento", async () => {
    const pac = new FakeFinkokAdapter();
    const { rawBody, signature } = pac.signWebhookFixture({
      event_id: "evt-cfdi-3",
      type: "cfdi.cancelado",
      uuid: "33333333-3333-3333-3333-333333333333",
      status: "cancelado",
      occurred_at: new Date().toISOString(),
    });
    await pac.verifyAndNormalizeWebhook(rawBody, signature);
    await expect(pac.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookReplayError);
  });
});
