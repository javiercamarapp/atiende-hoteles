// Idempotencia por clave externa, compartida por createCharge/timbrar/charge/issueKey.
import { describe, expect, it, vi } from "vitest";
import { InMemoryIdempotencyStore, withIdempotency } from "@atiende-hoteles/mcp-shared";

describe("InMemoryIdempotencyStore / withIdempotency", () => {
  it("la primera llamada ejecuta fn y guarda el resultado", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const fn = vi.fn().mockResolvedValue("resultado-1");
    const { result, replayed } = await withIdempotency(store, "key-1", fn);
    expect(result).toBe("resultado-1");
    expect(replayed).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("una segunda llamada con la MISMA clave reusa el resultado sin volver a llamar a fn", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const fn = vi.fn().mockResolvedValue("resultado-1");
    await withIdempotency(store, "key-1", fn);
    const { result, replayed } = await withIdempotency(store, "key-1", fn);
    expect(result).toBe("resultado-1");
    expect(replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // NUNCA se llamó dos veces al "proveedor"
  });

  it("claves distintas no colisionan entre sí", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const fn = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    const r1 = await withIdempotency(store, "key-1", fn);
    const r2 = await withIdempotency(store, "key-2", fn);
    expect(r1.result).toBe("a");
    expect(r2.result).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
  });
});
