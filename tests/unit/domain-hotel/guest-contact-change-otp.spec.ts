// REQ-HUE-023, mitad "cambio de contacto exige OTP al canal original": pruebas
// unitarias de la decisión pura (packages/domain-hotel/src/guestContactChangeOtp.ts).
// La prueba end-to-end (envío real al `guest.phone` original vía `FakeWhatsappAdapter`,
// nunca al valor nuevo solicitado) vive en
// tests/adversarial/guardrails-conversacionales.spec.ts.
//
// REQ-AGT-010, mitad "clave del límite de tasa" (número, tenant, país):
// `buildGuestContactOtpRateLimitKey` es pura (solo arma el string, no cuenta nada), así
// que se prueba aquí igual que el resto del archivo. El 429 real contra la ruta HTTP
// (N+1 solicitud sobre el límite configurado) vive en
// tests/adversarial/rate-limits-otp.spec.ts, junto con el caso negativo de OTP.
import { describe, expect, it } from "vitest";
import {
  buildGuestContactOtpRateLimitKey,
  OTP_CODE_LENGTH,
  evaluateOtpConfirmation,
  generateOtpCode,
} from "@atiende-hoteles/domain-hotel";

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

describe("buildGuestContactOtpRateLimitKey (REQ-AGT-010)", () => {
  it("es determinista: las mismas 2 entradas SIEMPRE producen la misma clave", () => {
    const a = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+5219981111111" });
    const b = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+5219981111111" });
    expect(a).toBe(b);
  });

  it("incluye el país derivado del prefijo E.164 del teléfono -- dos países distintos, misma clave-base, dan claves distintas", () => {
    const mx = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+5219981111111" });
    const us = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+14155551234" });
    expect(mx).not.toBe(us);
    // "país" es una dimensión real de la clave, no solo el número entero repetido.
    expect(mx).toContain("MX");
    expect(us).toContain("US_CA");
  });

  it("distingue por tenant: el MISMO número bajo tenants distintos nunca comparte balde", () => {
    const tenantA = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-a", phone: "+5219981111111" });
    const tenantB = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-b", phone: "+5219981111111" });
    expect(tenantA).not.toBe(tenantB);
  });

  it("distingue por número: 2 huéspedes del MISMO tenant/país nunca comparten balde", () => {
    const numero1 = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+5219981111111" });
    const numero2 = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "+5219982222222" });
    expect(numero1).not.toBe(numero2);
  });

  it("un teléfono sin prefijo E.164 reconocible NUNCA rompe la clave -- cae a un país honesto, no lanza", () => {
    expect(() => buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "no-es-un-telefono" })).not.toThrow();
    const desconocido = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-1", phone: "no-es-un-telefono" });
    expect(desconocido).toContain("DESCONOCIDA");
    // Sigue siendo única por tenant+teléfono aunque el país no se pueda clasificar.
    const otroTenant = buildGuestContactOtpRateLimitKey({ tenantId: "tenant-2", phone: "no-es-un-telefono" });
    expect(desconocido).not.toBe(otroTenant);
  });
});
