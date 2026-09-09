// H15-007/REQ-INT-002 · Prueba de CONTRATO real de `ConektaAdapter` (fetch de verdad)
// contra `tests/support/fakeConektaServer.ts` -- mismo criterio que
// `stripe-adapter.spec.ts`: prueba el código del adaptador de extremo a extremo, NUNCA
// contra `api.conekta.io` real. `verificadoContraReal` permanece `false` incluso después
// de esta prueba.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConektaAdapter, PreAuthExpiredError } from "@atiende-hoteles/mcp-payments";
import { PortUnavailableError } from "@atiende-hoteles/mcp-shared";
import { startFakeConektaServer, TEST_CARD_TOKENS, type FakeConektaServer } from "../../../support/fakeConektaServer.ts";

describe("contrato: ConektaAdapter real contra simulador HTTP local", () => {
  let server: FakeConektaServer;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    server = await startFakeConektaServer();
    process.env.CONEKTA_PRIVATE_KEY = server.privateKey;
    process.env.CONEKTA_WEBHOOK_SECRET = "webhook-secret-de-prueba";
  });

  afterAll(async () => {
    await server.close();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env.CONEKTA_PRIVATE_KEY = server.privateKey;
    process.env.CONEKTA_WEBHOOK_SECRET = "webhook-secret-de-prueba";
  });

  function makeAdapter(requestTimeoutMs = 5_000): ConektaAdapter {
    return new ConektaAdapter({ apiBase: server.apiBase, requestTimeoutMs });
  }

  it("status() reporta available=true con credenciales presentes", () => {
    expect(makeAdapter().status()).toEqual({ provider: "conekta", available: true, simulated: false });
  });

  it("nunca declara verificado contra el proveedor real, ni siquiera con la suite en verde", () => {
    expect(makeAdapter().verificadoContraReal).toBe(false);
  });

  it("charge(): camino feliz -- orden pagada de inmediato (paid -> capturado)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.charge({
      amount: 1500,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "conekta-charge-1",
    });
    expect(result.status).toBe("capturado");
    expect(result.amount).toBe(1500);
    expect(result.externalPaymentId).toMatch(/^ord_fake_/);
  });

  it("charge(): idempotente por idempotencyKey -- una segunda llamada no crea otra orden", async () => {
    const adapter = makeAdapter();
    const input = {
      amount: 700,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "conekta-charge-idem-1",
    };
    const first = await adapter.charge(input);
    const second = await adapter.charge(input);
    expect(second.externalPaymentId).toBe(first.externalPaymentId);
  });

  it("charge(): tarjeta rechazada -- HTTP 402 se traduce a PaymentResult status 'fallido', no un throw", async () => {
    const adapter = makeAdapter();
    const result = await adapter.charge({
      amount: 500,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_DECLINED,
      idempotencyKey: "conekta-charge-declined-1",
    });
    expect(result.status).toBe("fallido");
  });

  it("charge(): timeout de red propaga un error, nunca finge éxito", async () => {
    const adapter = makeAdapter(200);
    await expect(
      adapter.charge({
        amount: 500,
        currency: "MXN",
        paymentMethodToken: TEST_CARD_TOKENS.VISA_TIMEOUT,
        idempotencyKey: "conekta-charge-timeout-1",
      }),
    ).rejects.toThrow();
  });

  it("charge(): respuesta 2xx con cuerpo no-JSON falla explícito", async () => {
    const adapter = makeAdapter();
    server.corruptNextResponse();
    await expect(
      adapter.charge({
        amount: 500,
        currency: "MXN",
        paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
        idempotencyKey: "conekta-charge-corrupt-1",
      }),
    ).rejects.toThrow(/JSON válido/);
  });

  it("preAuthorize() retiene sin capturar (pending_payment interpretado como autorizado) y capturePreAuth() captura de verdad", async () => {
    const adapter = makeAdapter();
    const preAuth = await adapter.preAuthorize({
      amount: 3000,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "conekta-preauth-1",
      holdMinutes: 60,
    });
    expect(preAuth.status).toBe("autorizado");
    expect(preAuth.preAuthExpiresAt).toBeDefined();

    const captured = await adapter.capturePreAuth(preAuth.externalPaymentId, "conekta-cap-1");
    expect(captured.status).toBe("capturado");
  });

  it("capturePreAuth() sobre una orden ya vencida lanza PreAuthExpiredError", async () => {
    const adapter = makeAdapter();
    const preAuth = await adapter.preAuthorize({
      amount: 3000,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "conekta-preauth-2",
      holdMinutes: 60,
    });
    server.expireOrder(preAuth.externalPaymentId);
    await expect(adapter.capturePreAuth(preAuth.externalPaymentId, "conekta-cap-2")).rejects.toBeInstanceOf(
      PreAuthExpiredError,
    );
  });

  it("refund() reembolsa contra la orden real", async () => {
    const adapter = makeAdapter();
    const charge = await adapter.charge({
      amount: 800,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "conekta-charge-2",
    });
    const refund = await adapter.refund({
      externalPaymentId: charge.externalPaymentId,
      amount: 800,
      idempotencyKey: "conekta-refund-1",
    });
    expect(refund.status).toBe("reembolsado");
  });

  it("sin CONEKTA_PRIVATE_KEY/CONEKTA_WEBHOOK_SECRET, ningún método llama a la red -- PortUnavailableError inmediato", async () => {
    delete process.env.CONEKTA_PRIVATE_KEY;
    delete process.env.CONEKTA_WEBHOOK_SECRET;
    const adapter = makeAdapter();
    expect(adapter.status().available).toBe(false);
    await expect(
      adapter.charge({ amount: 100, currency: "MXN", paymentMethodToken: "tok", idempotencyKey: "y" }),
    ).rejects.toBeInstanceOf(PortUnavailableError);
  });
});
