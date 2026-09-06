// H2 · RateLimiter (apps/api/src/lib/rateLimit.ts): ventana fija en memoria, detrás de
// una interfaz `RateLimitStore` sustituible por Redis. Prueba pura, sin DB ni HTTP.
import { describe, expect, it, vi } from "vitest";
import { RateLimiter, MemoryRateLimitStore } from "@atiende-hoteles/api";

describe("RateLimiter (MemoryRateLimitStore)", () => {
  it("permite hasta el límite configurado y luego bloquea dentro de la misma ventana", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
    expect(limiter.check("k").allowed).toBe(false);
  });

  it("claves distintas tienen contadores independientes", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("la ventana expira y reinicia el contador", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
      expect(limiter.check("k").allowed).toBe(true);
      expect(limiter.check("k").allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(limiter.check("k").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expone el conteo de claves activas en el store (util para observabilidad/pruebas)", () => {
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, store });
    limiter.check("x");
    limiter.check("y");
    expect(store.size).toBe(2);
  });
});
