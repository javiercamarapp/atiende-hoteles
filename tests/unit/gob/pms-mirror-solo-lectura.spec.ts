// REQ-GOB-013 (GOB-016, ADR-005, BP-011, BP-140; parte de cerraduras compartida con
// REQ-BO-029/REQ-SEG-015, GOB-044, ADR-011): "ningún módulo de lógica de negocio fuera
// del conector PMS escribe en `pms_mirror` (solo lectura); ninguna regla automática
// invoca directamente el control de cerraduras." Prueba adversarial: inyecta código
// sintético que SÍ viola cada regla (escritura SQL/query-builder a `pms_mirror` fuera
// del conector, referencia a `LockPort`/`mcp-locks` fuera del paquete de cerraduras) y
// confirma que `checkPmsMirrorSoloLectura` lo detecta -- nunca solo el caso feliz.
// Corre contra directorios temporales sintéticos (mismo patrón que
// tests/unit/agent-core/ocr-aislado-sin-internet.spec.ts), nunca contra el repo real
// para los casos negativos, para no depender de ni poder romper su estado; el último
// caso SÍ corre contra el árbol real (apps/**, packages/**) para confirmar que hoy
// cierra en verde.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPmsMirrorSoloLectura } from "../../../scripts/checks/pms-mirror-solo-lectura.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "pms-mirror-solo-lectura-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkPmsMirrorSoloLectura", () => {
  describe("(a) escritura a pms_mirror fuera del conector PMS", () => {
    it("detecta un INSERT INTO pms_mirror fuera del conector", () => {
      const root = crearDirTemporal();
      writeFileSync(
        join(root, "reglaDeNegocio.ts"),
        'await db.query("insert into pms_mirror (hotel_id, external_id) values ($1, $2)", [a, b]);\n',
      );
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("escritura-fuera-de-conector-pms");
      expect(violations[0]!.file).toBe("reglaDeNegocio.ts");
    });

    it("detecta UPDATE, DELETE y TRUNCATE contra pms_mirror como violaciones separadas", () => {
      const root = crearDirTemporal();
      writeFileSync(join(root, "a.ts"), 'db.query("update pms_mirror set status = $1 where id = $2", [s, id]);\n');
      writeFileSync(join(root, "b.ts"), 'db.query("delete from public.pms_mirror where id = $1", [id]);\n');
      writeFileSync(join(root, "c.ts"), 'db.query("truncate table pms_mirror");\n');
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations.map((v) => v.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(violations.every((v) => v.category === "escritura-fuera-de-conector-pms")).toBe(true);
    });

    it("detecta una escritura estilo query-builder/ORM contra pms_mirror", () => {
      const root = crearDirTemporal();
      writeFileSync(join(root, "orm.ts"), "await pmsMirror.update({ status: 'x' }).where('id', id);\n");
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("escritura-fuera-de-conector-pms");
    });

    it("NO marca al conector PMS real (packages/mcp-servers/pms) escribiendo en pms_mirror", () => {
      const root = crearDirTemporal();
      const connectorDir = join(root, "packages", "mcp-servers", "pms", "src");
      mkdirSync(connectorDir, { recursive: true });
      writeFileSync(join(connectorDir, "sync.ts"), 'db.query("insert into pms_mirror (hotel_id) values ($1)", [id]);\n');
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(0);
    });

    it("NO marca a apps/api/src/pms (carpeta homónima que NO es el conector) -- sí debe revisarse", () => {
      const root = crearDirTemporal();
      const homonymDir = join(root, "apps", "api", "src", "pms");
      mkdirSync(homonymDir, { recursive: true });
      writeFileSync(join(homonymDir, "dbRoomRatePort.ts"), 'db.query("insert into pms_mirror (hotel_id) values ($1)", [id]);\n');
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("escritura-fuera-de-conector-pms");
    });

    it("NO marca una simple lectura (SELECT) de pms_mirror fuera del conector", () => {
      const root = crearDirTemporal();
      writeFileSync(join(root, "lectura.ts"), 'db.query("select * from pms_mirror where hotel_id = $1", [id]);\n');
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(0);
    });

    it("NO marca una línea de comentario que solo discute la regla", () => {
      const root = crearDirTemporal();
      writeFileSync(join(root, "README-ish.ts"), "// nunca hacer insert into pms_mirror desde lógica de negocio\n// tampoco un update pms_mirror set x=1\n");
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(0);
    });
  });

  describe("(b) invocación directa de cerraduras fuera del paquete de cerraduras", () => {
    it("detecta un import de @atiende-hoteles/mcp-locks fuera de packages/mcp-servers/locks", () => {
      const root = crearDirTemporal();
      writeFileSync(
        join(root, "reglaDeEnergia.ts"),
        'import { issueKey } from "@atiende-hoteles/mcp-locks";\nexport function apagarYAbrir() { issueKey(); }\n',
      );
      const violations = checkPmsMirrorSoloLectura([root], root);
      const categorias = violations.map((v) => v.category);
      expect(categorias).toContain("invocacion-directa-de-cerraduras");
      expect(violations.some((v) => v.file === "reglaDeEnergia.ts" && v.line === 1)).toBe(true);
    });

    it("detecta LockPort, revokeKey y DigitalKey como patrones distintos", () => {
      const root = crearDirTemporal();
      writeFileSync(join(root, "a.ts"), "function f(p: LockPort) { return p; }\n");
      writeFileSync(join(root, "b.ts"), "revokeKey(id);\n");
      writeFileSync(join(root, "c.ts"), "const k: DigitalKey = crearLlave();\n");
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations.filter((v) => v.category === "invocacion-directa-de-cerraduras").map((v) => v.file).sort()).toEqual([
        "a.ts",
        "b.ts",
        "c.ts",
      ]);
    });

    it("NO marca al propio paquete de cerraduras (packages/mcp-servers/locks) definiendo su vocabulario", () => {
      const root = crearDirTemporal();
      const locksDir = join(root, "packages", "mcp-servers", "locks", "src");
      mkdirSync(locksDir, { recursive: true });
      writeFileSync(join(locksDir, "port.ts"), "export interface LockPort { issueKey(): void; revokeKey(): void; }\n");
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(0);
    });

    it("NO marca una línea de comentario que solo discute la regla (mismo patrón que lock-isolation.spec.ts)", () => {
      const root = crearDirTemporal();
      writeFileSync(
        join(root, "energy-port.ts"),
        "// Diseño deliberado: este puerto NUNCA importa @atiende-hoteles/mcp-locks ni referencia LockPort.\n",
      );
      const violations = checkPmsMirrorSoloLectura([root], root);
      expect(violations).toHaveLength(0);
    });
  });

  it("un árbol limpio (sin violaciones de ninguna de las dos reglas) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "reservas.ts"),
      'import { z } from "zod";\nconst schema = z.object({ reservationId: z.string() });\nexport function noop() {}\n',
    );
    const violations = checkPmsMirrorSoloLectura([root], root);
    expect(violations).toHaveLength(0);
  });

  it("el árbol real del repo (apps/**, packages/**) no produce violaciones hoy", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const violations = checkPmsMirrorSoloLectura([join(root, "apps"), join(root, "packages")], root);
    expect(violations).toEqual([]);
  });
});
