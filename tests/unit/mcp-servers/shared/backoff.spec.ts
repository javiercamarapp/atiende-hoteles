// Utilidades compartidas de reintento (ADR-007: "manejo de Retry-After... es parte
// obligatoria del esqueleto del adaptador real").
import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, retryWithBackoff } from "@atiende-hoteles/mcp-shared";

describe("computeBackoffDelayMs", () => {
  it("crece exponencialmente con el intento, respetando el techo maxDelayMs", () => {
    const alwaysMax = () => 1; // jitter fijo en el máximo posible
    expect(computeBackoffDelayMs(1, 100, 10_000, alwaysMax)).toBe(100);
    expect(computeBackoffDelayMs(2, 100, 10_000, alwaysMax)).toBe(200);
    expect(computeBackoffDelayMs(3, 100, 10_000, alwaysMax)).toBe(400);
    expect(computeBackoffDelayMs(10, 100, 10_000, alwaysMax)).toBe(10_000);
  });

  it("con jitter 0 el retardo es 0 (full jitter, no un piso fijo)", () => {
    expect(computeBackoffDelayMs(5, 100, 10_000, () => 0)).toBe(0);
  });
});

describe("retryWithBackoff", () => {
  it("retorna el resultado del primer intento exitoso sin reintentar", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reintenta hasta maxAttempts y luego relanza el último error (nunca lo traga)", async () => {
    const error = new Error("caído");
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, sleep: async () => {}, random: () => 0 }),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("se recupera si un intento intermedio tiene éxito", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValueOnce("listo");
    const result = await retryWithBackoff(fn, { maxAttempts: 5, sleep: async () => {}, random: () => 0 });
    expect(result).toBe("listo");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("no reintenta si isRetryable devuelve false", async () => {
    const error = new Error("fatal, no reintentable");
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      retryWithBackoff(fn, { maxAttempts: 5, sleep: async () => {}, isRetryable: () => false }),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("usa retryAfterMs explícito (p.ej. header Retry-After) en vez del backoff calculado", async () => {
    const sleepCalls: number[] = [];
    const error = { retryAfterHint: 777 };
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn, {
      maxAttempts: 2,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      retryAfterMs: (e) => (e as { retryAfterHint: number }).retryAfterHint,
    });
    expect(result).toBe("ok");
    expect(sleepCalls).toEqual([777]);
  });
});
