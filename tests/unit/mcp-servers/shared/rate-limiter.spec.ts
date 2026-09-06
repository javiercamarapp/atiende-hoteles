// Rate limiter tipo token-bucket, mitigación de "límites de tasa no publicados" (H15 §5).
import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "@atiende-hoteles/mcp-shared";

describe("TokenBucketRateLimiter", () => {
  it("permite consumir hasta la capacidad, luego bloquea", () => {
    const now = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => now });
    expect(limiter.tryConsume().allowed).toBe(true);
    expect(limiter.tryConsume().allowed).toBe(true);
    expect(limiter.tryConsume().allowed).toBe(true);
    const fourth = limiter.tryConsume();
    expect(fourth.allowed).toBe(false);
    expect(fourth.waitMs).toBeGreaterThan(0);
  });

  it("repone tokens con el paso del tiempo simulado", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(limiter.tryConsume().allowed).toBe(true);
    expect(limiter.tryConsume().allowed).toBe(false);
    now += 1000; // 1 segundo despues -> 1 token repuesto
    expect(limiter.tryConsume().allowed).toBe(true);
  });

  it("nunca excede la capacidad máxima aunque pase mucho tiempo", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 10, now: () => now });
    now += 100_000;
    expect(limiter.available()).toBe(2);
  });
});
