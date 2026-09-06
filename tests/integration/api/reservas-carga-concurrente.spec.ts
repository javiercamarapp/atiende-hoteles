// RENDIMIENTO/CRÍTICO (auditoría-2, docs/auditoria-2/rendimiento.md): GET
// /hoteles/:hotelId/reservas registraba el middleware de sesión de BD (`dbSession`)
// DOS veces -- una vez por la ruta exacta ("/hoteles/:hotelId/reservas") y otra por el
// comodín ("/hoteles/:hotelId/reservas/*", que en Hono también hace match de la ruta
// exacta sin segmento adicional) -- abriendo DOS conexiones del pool compartido por
// request. Bajo concurrencia real esto agota el pool y produce fallos 500 (timeout de
// `pool.connect()`), arrastrando también otras rutas que comparten el mismo pool
// (p.ej. /disponibilidad). El mismo patrón existía en huespedes.ts.
//
// Esta prueba fuerza un pool pequeño (`poolMax`) y dispara 50 GET concurrentes contra
// la ruta que tenía el defecto: con el arreglo (un solo `app.use` "reservas*"), cada
// request consume UN solo slot del pool -- 0 fallos, sin más contención que la cola
// normal de un pool compartido.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("rendimiento: GET /reservas bajo concurrencia no agota el pool (una sola sesión de BD por request)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;

  beforeAll(async () => {
    // Pool deliberadamente pequeño: si el request consumiera 2 conexiones (el defecto
    // original), 50 peticiones concurrentes pedirían hasta 100 slots contra un pool de
    // 12 -- garantizado a producir timeouts. Con 1 conexión por request, 50 peticiones
    // contra un pool de 12 solo hacen cola (sin fallos).
    fixture = await createApiFixture({ poolMax: 12 });
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("50 GET /hoteles/:hotelId/reservas concurrentes: 0 fallos, p95 < 500ms", async () => {
    const CONCURRENCY = 50;
    const auth = { authorization: `Bearer ${gmToken}` };

    const timings = await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const start = performance.now();
        const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, { headers: auth });
        const elapsedMs = performance.now() - start;
        return { status: res.status, elapsedMs };
      }),
    );

    const failures = timings.filter((t) => t.status !== 200);
    expect(failures).toEqual([]);

    const sorted = timings.map((t) => t.elapsedMs).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(500);
  });

  it("50 GET /hoteles/:hotelId/huespedes concurrentes: 0 fallos (mismo defecto en huespedes.ts)", async () => {
    const CONCURRENCY = 50;
    const auth = { authorization: `Bearer ${gmToken}` };

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => fixture.app.request(`/hoteles/${hotelId}/huespedes`, { headers: auth })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("no deja el pool sin capacidad para otra ruta concurrente en el mismo lote (idempotency-key distinta por request)", async () => {
    const auth = { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
    const [reservas, disponibilidad] = await Promise.all([
      Promise.all(Array.from({ length: 25 }, () => fixture.app.request(`/hoteles/${hotelId}/reservas`, { headers: auth }))),
      Promise.all(
        Array.from({ length: 25 }, () =>
          fixture.app.request(`/hoteles/${hotelId}/huespedes`, { headers: { ...auth, "idempotency-key": randomUUID() } }),
        ),
      ),
    ]);
    expect(reservas.every((r) => r.status === 200)).toBe(true);
    expect(disponibilidad.every((r) => r.status === 200)).toBe(true);
  });
});
