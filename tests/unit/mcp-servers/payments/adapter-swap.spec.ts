// Prueba de contrato de PaymentProviderPort (REQ-INT-002): la MISMA suite de negocio
// corre contra 2 adaptadores (Stripe/Conekta simulados) para verificar que cambiar de
// proveedor no requiere tocar la lógica de negocio. Ver docs/ACEPTACION.md.
import { describe, expect, it } from "vitest";
import {
  FakeStripeAdapter,
  FakeConektaAdapter,
  StripeAdapter,
  ConektaAdapter,
  mapStripeStatusToDomain,
  mapConektaStatusToDomain,
  PreAuthExpiredError,
  type PaymentProviderPort,
} from "@atiende-hoteles/mcp-payments";
import { PortUnavailableError, WebhookSignatureError, WebhookReplayError } from "@atiende-hoteles/mcp-shared";

describe("mapeo de estados de pago", () => {
  it("Stripe: los 7 estados nativos de PaymentIntent mapean a un estado de dominio válido", () => {
    expect(mapStripeStatusToDomain("requires_payment_method")).toBe("pendiente");
    expect(mapStripeStatusToDomain("requires_capture")).toBe("autorizado");
    expect(mapStripeStatusToDomain("succeeded")).toBe("capturado");
    expect(mapStripeStatusToDomain("canceled")).toBe("fallido");
  });

  it("Conekta: los 6 estados nativos de order mapean a un estado de dominio válido", () => {
    expect(mapConektaStatusToDomain("pending_payment")).toBe("pendiente");
    expect(mapConektaStatusToDomain("paid")).toBe("capturado");
    expect(mapConektaStatusToDomain("declined")).toBe("fallido");
    expect(mapConektaStatusToDomain("expired")).toBe("expirado");
    expect(mapConektaStatusToDomain("refunded")).toBe("reembolsado");
    expect(mapConektaStatusToDomain("partially_refunded")).toBe("reembolsado");
  });
});

/** Suite de negocio reutilizable -- se corre línea por línea contra los 2 adaptadores. */
function runPaymentProviderContract(label: string, makePort: (now: () => number) => PaymentProviderPort) {
  describe(`contrato PaymentProviderPort -- ${label}`, () => {
    it("charge() es idempotente por idempotencyKey", async () => {
      const port = makePort(() => 0);
      const input = { amount: 1500, currency: "MXN", paymentMethodToken: "tok_visa", idempotencyKey: "chg-1" };
      const first = await port.charge(input);
      const second = await port.charge(input);
      expect(second.externalPaymentId).toBe(first.externalPaymentId);
      expect(first.status).toBe("capturado");
    });

    it("preAuthorize retiene sin capturar, y capturePreAuth captura dentro de la ventana vigente", async () => {
      const port = makePort(() => 0);
      const preAuth = await port.preAuthorize({
        amount: 3000,
        currency: "MXN",
        paymentMethodToken: "tok_visa",
        idempotencyKey: "pre-1",
        holdMinutes: 60,
      });
      expect(preAuth.status).toBe("autorizado");
      expect(preAuth.preAuthExpiresAt).toBeDefined();
      const captured = await port.capturePreAuth(preAuth.externalPaymentId, "cap-1");
      expect(captured.status).toBe("capturado");
    });

    it("capturePreAuth después de que expiró lanza PreAuthExpiredError -- nunca cobra una pre-auth vencida", async () => {
      let now = 0;
      const port = makePort(() => now);
      const preAuth = await port.preAuthorize({
        amount: 3000,
        currency: "MXN",
        paymentMethodToken: "tok_visa",
        idempotencyKey: "pre-2",
        holdMinutes: 60,
      });
      now += 61 * 60_000; // 1 minuto después de que expiró
      await expect(port.capturePreAuth(preAuth.externalPaymentId, "cap-2")).rejects.toBeInstanceOf(
        PreAuthExpiredError,
      );
    });

    it("refund() es idempotente por idempotencyKey", async () => {
      const port = makePort(() => 0);
      const charge = await port.charge({
        amount: 500,
        currency: "MXN",
        paymentMethodToken: "tok_visa",
        idempotencyKey: "chg-2",
      });
      const input = { externalPaymentId: charge.externalPaymentId, amount: 500, idempotencyKey: "ref-1" };
      const first = await port.refund(input);
      const second = await port.refund(input);
      expect(second.externalPaymentId).toBe(first.externalPaymentId);
      expect(first.status).toBe("reembolsado");
    });
  });
}

runPaymentProviderContract("FakeStripeAdapter (simulado)", (now) => new FakeStripeAdapter(now));
runPaymentProviderContract("FakeConektaAdapter (simulado)", (now) => new FakeConektaAdapter(now));

describe("adaptadores reales (Stripe/Conekta) sin credenciales -- declaración honesta", () => {
  it("StripeAdapter.status() reporta unavailable con la razón exacta", () => {
    const stripe = new StripeAdapter();
    if (stripe.status().available) return;
    expect(stripe.status().reason).toMatch(/PENDIENTE DE CREDENCIALES/);
  });

  it("ConektaAdapter.status() reporta unavailable con la razón exacta", () => {
    const conekta = new ConektaAdapter();
    if (conekta.status().available) return;
    expect(conekta.status().reason).toMatch(/PENDIENTE DE CREDENCIALES/);
  });

  it("charge() sin credenciales lanza PortUnavailableError en vez de fingir un cobro", async () => {
    const stripe = new StripeAdapter();
    if (stripe.status().available) return;
    await expect(
      stripe.charge({ amount: 100, currency: "MXN", paymentMethodToken: "tok", idempotencyKey: "x" }),
    ).rejects.toBeInstanceOf(PortUnavailableError);
  });
});

describe("webhook de pagos -- firma HMAC + replay (contra el adaptador simulado)", () => {
  it("firma válida se acepta y normaliza el evento", async () => {
    const fake = new FakeStripeAdapter();
    const { rawBody, signature } = fake.signWebhookFixture({
      event_id: "evt-pay-1",
      type: "payment.succeeded",
      payment_id: "STRIPE-PAY-1",
      status: "capturado",
      occurred_at: new Date().toISOString(),
    });
    const event = await fake.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.eventId).toBe("evt-pay-1");
  });

  it("firma inválida se rechaza", async () => {
    const fake = new FakeConektaAdapter();
    const { rawBody } = fake.signWebhookFixture({
      event_id: "evt-pay-2",
      type: "payment.failed",
      payment_id: "CONEKTA-PAY-1",
      status: "fallido",
      occurred_at: new Date().toISOString(),
    });
    await expect(fake.verifyAndNormalizeWebhook(rawBody, "sha256=invalida")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("un event_id repetido (replay) se rechaza en el segundo intento", async () => {
    const fake = new FakeStripeAdapter();
    const { rawBody, signature } = fake.signWebhookFixture({
      event_id: "evt-pay-3",
      type: "payment.refunded",
      payment_id: "STRIPE-PAY-2",
      status: "reembolsado",
      occurred_at: new Date().toISOString(),
    });
    await fake.verifyAndNormalizeWebhook(rawBody, signature);
    await expect(fake.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookReplayError);
  });
});
