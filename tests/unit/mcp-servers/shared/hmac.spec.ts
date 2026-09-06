// Firma HMAC de webhooks (GOB-042) + guarda de replay, compartida por PMS/WhatsApp/
// pagos/CFDI. Fail-closed: firma ausente/inválida nunca se trata como válida.
import { describe, expect, it } from "vitest";
import { signHmac, verifyHmacSignature, InMemoryReplayGuard } from "@atiende-hoteles/mcp-shared";

describe("signHmac / verifyHmacSignature", () => {
  const secret = "un-secreto-de-prueba";
  const payload = JSON.stringify({ event_id: "evt-1", foo: "bar" });

  it("una firma válida se verifica correctamente", () => {
    const signature = signHmac(payload, secret);
    expect(verifyHmacSignature(payload, signature, secret)).toBe(true);
  });

  it("una firma con el secreto incorrecto se rechaza", () => {
    const signature = signHmac(payload, "otro-secreto");
    expect(verifyHmacSignature(payload, signature, secret)).toBe(false);
  });

  it("un payload alterado tras firmarlo invalida la firma", () => {
    const signature = signHmac(payload, secret);
    const tampered = JSON.stringify({ event_id: "evt-1", foo: "tampered" });
    expect(verifyHmacSignature(tampered, signature, secret)).toBe(false);
  });

  it("firma ausente (undefined/null) se rechaza, nunca se trata como válida", () => {
    expect(verifyHmacSignature(payload, undefined, secret)).toBe(false);
    expect(verifyHmacSignature(payload, null, secret)).toBe(false);
    expect(verifyHmacSignature(payload, "", secret)).toBe(false);
  });

  it("secreto vacío nunca produce una verificación válida", () => {
    const signature = signHmac(payload, secret);
    expect(verifyHmacSignature(payload, signature, "")).toBe(false);
  });

  it("respeta prefijo/algoritmo configurables (p.ej. formato Stripe sin prefijo)", () => {
    const signature = signHmac(payload, secret, { prefix: "" });
    expect(signature.startsWith("sha256=")).toBe(false);
    expect(verifyHmacSignature(payload, signature, secret, { prefix: "" })).toBe(true);
  });
});

describe("InMemoryReplayGuard", () => {
  it("la primera vez que ve un event_id retorna false (no es replay)", () => {
    const guard = new InMemoryReplayGuard();
    expect(guard.seenBefore("evt-1")).toBe(false);
  });

  it("la segunda vez que ve el MISMO event_id retorna true (replay)", () => {
    const guard = new InMemoryReplayGuard();
    guard.seenBefore("evt-1");
    expect(guard.seenBefore("evt-1")).toBe(true);
  });

  it("event_id distintos no colisionan entre sí", () => {
    const guard = new InMemoryReplayGuard();
    expect(guard.seenBefore("evt-1")).toBe(false);
    expect(guard.seenBefore("evt-2")).toBe(false);
  });

  it("un evento expirado (fuera del TTL) ya no cuenta como replay", () => {
    const guard = new InMemoryReplayGuard(1000);
    expect(guard.seenBefore("evt-1", 0)).toBe(false);
    expect(guard.seenBefore("evt-1", 5000)).toBe(false);
  });
});
