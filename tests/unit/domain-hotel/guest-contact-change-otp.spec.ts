// REQ-HUE-023, mitad "cambio de contacto exige OTP al canal original": pruebas
// unitarias de la decisión pura (packages/domain-hotel/src/guestContactChangeOtp.ts).
// La prueba end-to-end (envío real al `guest.phone` original vía `FakeWhatsappAdapter`,
// nunca al valor nuevo solicitado) vive en
// tests/adversarial/guardrails-conversacionales.spec.ts.
import { describe, expect, it } from "vitest";
import { OTP_CODE_LENGTH, evaluateOtpConfirmation, generateOtpCode } from "@atiende-hoteles/domain-hotel";

describe("generateOtpCode", () => {
  it("genera un código numérico de OTP_CODE_LENGTH dígitos, con ceros a la izquierda si hace falta", () => {
    // randomIntFn inyectado en 0 para forzar el caso límite (ceros a la izquierda).
    expect(generateOtpCode(() => 0)).toBe("0".repeat(OTP_CODE_LENGTH));
    const codigo = generateOtpCode();
    expect(codigo).toHaveLength(OTP_CODE_LENGTH);
    expect(/^\d+$/.test(codigo)).toBe(true);
  });

  it("nunca repite el mismo código en 200 generaciones reales (CSPRNG, no un contador)", () => {
    const codigos = new Set(Array.from({ length: 200 }, () => generateOtpCode()));
    // No exige unicidad perfecta (hay colisión posible en 10^6 espacios), pero sí que
    // la enorme mayoría sean distintos -- una implementación rota (p.ej. siempre "0")
    // fallaría esto con size === 1.
    expect(codigos.size).toBeGreaterThan(190);
  });
});

describe("evaluateOtpConfirmation", () => {
  const base = {
    status: "pendiente" as const,
    expiresAt: new Date("2026-01-01T12:10:00Z"),
    now: new Date("2026-01-01T12:00:00Z"),
    attemptsBefore: 0,
    maxAttempts: 5,
    codeMatches: true,
  };

  it("acepta y aplica el cambio con código correcto, vigente, sin intentos agotados", () => {
    const result = evaluateOtpConfirmation(base);
    expect(result.outcome).toBe("aceptado");
    expect(result.applyChange).toBe(true);
    expect(result.nextStatus).toBe("confirmado");
    expect(result.attemptsAfter).toBe(0);
  });

  it("rechaza un código incorrecto, mantiene 'pendiente' y permite reintentar", () => {
    const result = evaluateOtpConfirmation({ ...base, codeMatches: false });
    expect(result.outcome).toBe("rechazado_codigo_incorrecto");
    expect(result.applyChange).toBe(false);
    expect(result.nextStatus).toBe("pendiente");
    expect(result.attemptsAfter).toBe(1);
  });

  it("rechaza por expiración incluso con código correcto (expiración gana sobre el código)", () => {
    const result = evaluateOtpConfirmation({ ...base, now: new Date("2026-01-01T12:11:00Z"), codeMatches: true });
    expect(result.outcome).toBe("rechazado_expirado");
    expect(result.applyChange).toBe(false);
    expect(result.nextStatus).toBe("rechazado_expirado");
    expect(result.attemptsAfter).toBe(0);
  });

  it("agota los intentos en el N-ésimo código incorrecto y deja de aceptar reintentos", () => {
    const casiAgotado = evaluateOtpConfirmation({ ...base, attemptsBefore: 4, codeMatches: false });
    expect(casiAgotado.outcome).toBe("rechazado_intentos_agotados");
    expect(casiAgotado.nextStatus).toBe("rechazado_intentos_agotados");
    expect(casiAgotado.attemptsAfter).toBe(5);

    const yaAgotado = evaluateOtpConfirmation({ ...base, status: "rechazado_intentos_agotados", attemptsBefore: 5, codeMatches: true });
    expect(yaAgotado.outcome).toBe("rechazado_ya_confirmado");
    expect(yaAgotado.applyChange).toBe(false);
  });

  it("un código correcto NUNCA reabre una solicitud ya confirmada/cancelada", () => {
    const confirmada = evaluateOtpConfirmation({ ...base, status: "confirmado", codeMatches: true });
    expect(confirmada.outcome).toBe("rechazado_ya_confirmado");
    expect(confirmada.applyChange).toBe(false);

    const cancelada = evaluateOtpConfirmation({ ...base, status: "cancelado", codeMatches: true });
    expect(cancelada.outcome).toBe("rechazado_ya_confirmado");
    expect(cancelada.applyChange).toBe(false);
  });

  it("el intento que agota el máximo también se rechaza por intentos agotados, no por código", () => {
    // attemptsBefore ya en el máximo: ni siquiera compara el código de este intento.
    const result = evaluateOtpConfirmation({ ...base, attemptsBefore: 5, codeMatches: true });
    expect(result.outcome).toBe("rechazado_intentos_agotados");
    expect(result.applyChange).toBe(false);
  });
});
