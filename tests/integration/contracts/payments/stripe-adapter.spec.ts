// H15-007/REQ-INT-002 · Prueba de CONTRATO real de `StripeAdapter` (fetch de verdad, sin
// mock de `fetch`) contra `tests/support/fakeStripeServer.ts` -- un simulador HTTP local
// que imita el contrato público documentado de la API de PaymentIntents/Refunds de
// Stripe. Esto prueba el código del adaptador (parseo de respuesta, headers de
// autenticación/idempotencia, mapeo de estado, manejo de rechazo/timeout/respuesta
// malformada) de extremo a extremo -- NUNCA contra `api.stripe.com` real (sin
// credenciales de sandbox en este entorno, ver README.md del paquete). `verificadoContraReal`
// permanece `false` incluso después de esta prueba: verde aquí demuestra que el
// ADAPTADOR cumple el contrato documentado, no que Stripe real se comporte así.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StripeAdapter, PreAuthExpiredError } from "@atiende-hoteles/mcp-payments";
import { PortUnavailableError } from "@atiende-hoteles/mcp-shared";
import { startFakeStripeServer, TEST_CARD_TOKENS, type FakeStripeServer } from "../../../support/fakeStripeServer.ts";

describe("contrato: StripeAdapter real contra simulador HTTP local", () => {
  let server: FakeStripeServer;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    server = await startFakeStripeServer();
    process.env.STRIPE_SECRET_KEY = server.secretKey;
    process.env.STRIPE_WEBHOOK_SECRET = "webhook-secret-de-prueba";
  });

  afterAll(async () => {
    await server.close();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = server.secretKey;
    process.env.STRIPE_WEBHOOK_SECRET = "webhook-secret-de-prueba";
  });

  function makeAdapter(requestTimeoutMs = 5_000): StripeAdapter {
    return new StripeAdapter({ apiBase: server.apiBase, requestTimeoutMs });
  }

  it("status() reporta available=true con credenciales presentes", () => {
    expect(makeAdapter().status()).toEqual({ provider: "stripe", available: true, simulated: false });
  });

  it("nunca declara verificado contra el proveedor real, ni siquiera con la suite en verde", () => {
    expect(makeAdapter().verificadoContraReal).toBe(false);
  });

  it("charge(): camino feliz -- confirma y captura de inmediato (succeeded -> capturado)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.charge({
      amount: 1500,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "stripe-charge-1",
    });
    expect(result.status).toBe("capturado");
    expect(result.amount).toBe(1500);
    expect(result.externalPaymentId).toMatch(/^pi_fake_/);
  });

  it("charge(): tarjeta rechazada -- HTTP 402 se traduce a PaymentResult status 'fallido', no un throw", async () => {
    const adapter = makeAdapter();
    const result = await adapter.charge({
      amount: 500,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_DECLINED,
      idempotencyKey: "stripe-charge-declined-1",
    });
    expect(result.status).toBe("fallido");
    expect(result.externalPaymentId).toMatch(/^pi_fake_/);
  });

  it("charge(): timeout de red -- nunca cuelga, nunca finge éxito, propaga un error", async () => {
    const adapter = makeAdapter(200);
    await expect(
      adapter.charge({
        amount: 500,
        currency: "MXN",
        paymentMethodToken: TEST_CARD_TOKENS.VISA_TIMEOUT,
        idempotencyKey: "stripe-charge-timeout-1",
      }),
    ).rejects.toThrow();
  });

  it("charge(): respuesta 2xx con cuerpo no-JSON falla explícito, nunca fabrica un resultado", async () => {
    const adapter = makeAdapter();
    server.corruptNextResponse();
    await expect(
      adapter.charge({
        amount: 500,
        currency: "MXN",
        paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
        idempotencyKey: "stripe-charge-corrupt-1",
      }),
    ).rejects.toThrow(/JSON válido/);
  });

  it("preAuthorize() retiene sin capturar (requires_capture -> autorizado) y capturePreAuth() captura de verdad", async () => {
    const adapter = makeAdapter();
    const preAuth = await adapter.preAuthorize({
      amount: 3000,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "stripe-preauth-1",
      holdMinutes: 60,
    });
    expect(preAuth.status).toBe("autorizado");
    expect(preAuth.preAuthExpiresAt).toBeDefined();

    const captured = await adapter.capturePreAuth(preAuth.externalPaymentId, "stripe-cap-1");
    expect(captured.status).toBe("capturado");
  });

  it("capturePreAuth() sobre una pre-auth que Stripe ya canceló lanza PreAuthExpiredError", async () => {
    const adapter = makeAdapter();
    const preAuth = await adapter.preAuthorize({
      amount: 3000,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "stripe-preauth-2",
      holdMinutes: 60,
    });
    server.expireIntent(preAuth.externalPaymentId);
    await expect(adapter.capturePreAuth(preAuth.externalPaymentId, "stripe-cap-2")).rejects.toBeInstanceOf(
      PreAuthExpiredError,
    );
  });

  it("refund() reembolsa contra el PaymentIntent real", async () => {
    const adapter = makeAdapter();
    const charge = await adapter.charge({
      amount: 800,
      currency: "MXN",
      paymentMethodToken: TEST_CARD_TOKENS.VISA_OK,
      idempotencyKey: "stripe-charge-2",
    });
    const refund = await adapter.refund({
      externalPaymentId: charge.externalPaymentId,
      amount: 800,
      idempotencyKey: "stripe-refund-1",
    });
    expect(refund.status).toBe("reembolsado");
    expect(refund.externalPaymentId).toMatch(/^re_fake_/);
  });

  it("sin STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET, ningún método llama a la red -- PortUnavailableError inmediato", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const adapter = makeAdapter();
    expect(adapter.status().available).toBe(false);
    await expect(
      adapter.charge({ amount: 100, currency: "MXN", paymentMethodToken: "tok", idempotencyKey: "x" }),
    ).rejects.toBeInstanceOf(PortUnavailableError);
  });
});
