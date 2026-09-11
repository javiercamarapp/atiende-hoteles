// Patrón Likida/atiende.ai #3 ("rate limiting distribuido fail-open/closed explícito",
// LAUNCH-022): `PostgresRateLimitStore` es el store REAL (no un esqueleto sin probar)
// que resuelve la brecha documentada en `deploy/README.md` -- `MemoryRateLimitStore`
// guarda el conteo en memoria del proceso, sin efecto real entre instancias serverless
// concurrentes. Corre contra PGlite real (packages/db/migrations/0131_rate_limit_bucket.sql),
// nunca contra un Map simulado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncRateLimiter, PostgresRateLimitStore, type RateLimitDbClient } from "../../../apps/api/src/lib/rateLimit.ts";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

describe("PostgresRateLimitStore (contra Postgres real, PGlite)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("primera llamada: count=1, resetAt ~ now+windowMs", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const before = Date.now();
    const result = await store.increment("ip:1.2.3.4", 60_000);
    expect(result.count).toBe(1);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(result.resetAt).toBeLessThanOrEqual(before + 60_000 + 5000);
  });

  it("llamadas sucesivas dentro de la MISMA ventana incrementan el contador sin reiniciar resetAt", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const first = await store.increment("ip:9.9.9.9", 60_000);
    const second = await store.increment("ip:9.9.9.9", 60_000);
    const third = await store.increment("ip:9.9.9.9", 60_000);
    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
    expect(second.resetAt).toBe(first.resetAt);
    expect(third.resetAt).toBe(first.resetAt);
  });

  it("claves distintas tienen contadores independientes", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const a = await store.increment("ip:a", 60_000);
    const b = await store.increment("ip:b", 60_000);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it("una ventana ya expirada reinicia el contador en 1 con un resetAt nuevo", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    // Ventana de 1ms: la segunda llamada, un poco despues, ya la encuentra expirada.
    const first = await store.increment("ip:expira", 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await store.increment("ip:expira", 60_000);
    expect(second.count).toBe(1);
    expect(second.resetAt).toBeGreaterThan(first.resetAt);
  });

  it("dos incrementos CONCURRENTES sobre la MISMA clave nunca se pisan (Postgres serializa la fila): terminan en 1 y 2, nunca 1 y 1", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const [a, b] = await Promise.all([store.increment("ip:concurrente", 60_000), store.increment("ip:concurrente", 60_000)]);
    const counts = [a.count, b.count].sort();
    expect(counts).toEqual([1, 2]);
  });

  it("persiste entre instancias DISTINTAS de PostgresRateLimitStore que comparten el mismo db (simula multi-instancia real)", async () => {
    const storeInstancia1 = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const storeInstancia2 = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    await storeInstancia1.increment("ip:multi-instancia", 60_000);
    const result = await storeInstancia2.increment("ip:multi-instancia", 60_000);
    // A diferencia de MemoryRateLimitStore (cada instancia tendría su propio Map, ambas
    // verían count=1): aquí la SEGUNDA instancia ve el conteo de la primera.
    expect(result.count).toBe(2);
  });

  describe("fail-open vs. fail-closed (la decisión que MemoryRateLimitStore nunca necesitó tomar)", () => {
    function fakeFailingDb(): RateLimitDbClient {
      return { query: vi.fn().mockRejectedValue(new Error("conexión a Postgres caída (simulado)")) };
    }

    it("fail-open: una falla del store NUNCA bloquea (count=0, siempre <= cualquier límite)", async () => {
      const onFailureLogged = vi.fn();
      const store = new PostgresRateLimitStore({ db: fakeFailingDb(), onFailure: "fail-open", onFailureLogged });
      const result = await store.increment("ip:1.1.1.1", 60_000);
      expect(result.count).toBe(0);
      expect(onFailureLogged).toHaveBeenCalledTimes(1);
    });

    it("fail-closed: una falla del store SIEMPRE bloquea (count=MAX_SAFE_INTEGER, > cualquier límite)", async () => {
      const store = new PostgresRateLimitStore({ db: fakeFailingDb(), onFailure: "fail-closed" });
      const result = await store.increment("ip:1.1.1.1", 60_000);
      expect(result.count).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("el store NUNCA lanza (ni fail-open ni fail-closed) -- el llamador nunca necesita un try/catch", async () => {
      const store = new PostgresRateLimitStore({ db: fakeFailingDb(), onFailure: "fail-closed" });
      await expect(store.increment("k", 1000)).resolves.toBeDefined();
    });
  });
});

describe("AsyncRateLimiter (integración con PostgresRateLimitStore real)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("permite hasta el límite configurado y luego bloquea dentro de la misma ventana", async () => {
    const store = new PostgresRateLimitStore({ db: fixture.engine.admin, onFailure: "fail-open" });
    const limiter = new AsyncRateLimiter({ limit: 3, windowMs: 60_000, store });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("con store en fail-open ante una falla real, el límite NUNCA bloquea aunque el número de llamadas exceda 'limit'", async () => {
    const store = new PostgresRateLimitStore({
      db: { query: vi.fn().mockRejectedValue(new Error("caído")) },
      onFailure: "fail-open",
    });
    const limiter = new AsyncRateLimiter({ limit: 1, windowMs: 60_000, store });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
  });

  it("con store en fail-closed ante una falla real, el límite SIEMPRE bloquea", async () => {
    const store = new PostgresRateLimitStore({
      db: { query: vi.fn().mockRejectedValue(new Error("caído")) },
      onFailure: "fail-closed",
    });
    const limiter = new AsyncRateLimiter({ limit: 1000, windowMs: 60_000, store });
    expect((await limiter.check("k")).allowed).toBe(false);
  });
});
