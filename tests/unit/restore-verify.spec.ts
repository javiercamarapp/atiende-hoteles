// auditoria-2/operabilidad [ALTO]: `scripts/restore.ts` declaraba
// "VERIFICACIÓN: conteo igual en todas las tablas" sobre un backup con 0 tablas --
// `[].every(...)` es `true` por vacuidad, y nada más verificaba que hubo al menos una
// tabla/fila real. Esta prueba fija el contrato de `evaluarVerificacion` (lógica pura,
// sin BD real) que reemplaza esa condición.
import { describe, expect, it } from "vitest";
import { evaluarVerificacion } from "../../scripts/restore.ts";

describe("evaluarVerificacion (scripts/restore.ts)", () => {
  it("origen con 0 tablas: falla explícitamente, NUNCA 'conteo igual' (regresión del hallazgo real)", () => {
    const resultado = evaluarVerificacion(new Map(), new Map());
    expect(resultado.ok).toBe(false);
    expect(resultado.motivoFalla).toMatch(/NINGUNA tabla/);
  });

  it("origen sin filas en schema_migrations: falla (esquema nunca migrado)", () => {
    const origen = new Map([
      ["schema_migrations", 0],
      ["hotel", 3],
    ]);
    const restaurado = new Map([
      ["schema_migrations", 0],
      ["hotel", 3],
    ]);
    const resultado = evaluarVerificacion(origen, restaurado);
    expect(resultado.ok).toBe(false);
    expect(resultado.motivoFalla).toMatch(/schema_migrations/);
  });

  it("conteo real igual en todas las tablas, con migraciones aplicadas: ok", () => {
    const origen = new Map([
      ["schema_migrations", 41],
      ["hotel", 2],
      ["reservation", 336],
    ]);
    const restaurado = new Map([
      ["schema_migrations", 41],
      ["hotel", 2],
      ["reservation", 336],
    ]);
    const resultado = evaluarVerificacion(origen, restaurado);
    expect(resultado.ok).toBe(true);
    expect(resultado.motivoFalla).toBeNull();
    expect(resultado.totalRowsOrigen).toBe(379);
    expect(resultado.totalRowsRestaurado).toBe(379);
  });

  it("divergencia real de filas en una tabla: falla con motivo específico", () => {
    const origen = new Map([
      ["schema_migrations", 41],
      ["reservation", 336],
    ]);
    const restaurado = new Map([
      ["schema_migrations", 41],
      ["reservation", 300],
    ]);
    const resultado = evaluarVerificacion(origen, restaurado);
    expect(resultado.ok).toBe(false);
    expect(resultado.motivoFalla).toMatch(/Divergencia/);
  });

  it("el restaurado tiene menos tablas que el origen: falla (no solo cuenta filas por tabla presente)", () => {
    const origen = new Map([
      ["schema_migrations", 41],
      ["reservation", 5],
      ["guest", 2],
    ]);
    const restaurado = new Map([
      ["schema_migrations", 41],
      ["reservation", 5],
    ]);
    const resultado = evaluarVerificacion(origen, restaurado);
    expect(resultado.ok).toBe(false);
    expect(resultado.motivoFalla).toMatch(/número de tablas distinto/);
  });
});
