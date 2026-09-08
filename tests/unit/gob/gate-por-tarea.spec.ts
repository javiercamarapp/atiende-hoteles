// REQ-AGT-019 (GOB-048, BP-132..135): "Cada tarea del backlog que module archivos de
// agentes/precios/dinero/control físico lleva un `gate` (connector/money/physical/none)
// verificado automáticamente antes de mergear (contract tests, prueba de determinismo
// de precio, laboratorio físico según el gate)." Corre contra directorios temporales
// sintéticos (tareas .md reales, archivos de prueba "requeridos" reales que existen o
// no en disco) -- mismo patrón que
// tests/unit/gob/no-comandos-destructivos-agente.spec.ts -- nunca contra el repo real
// (que hoy no tiene `tasks/`, ver el propio script).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGatePorTarea,
  parseTaskFrontmatter,
  VALID_GATES,
  type CategoryRule,
} from "../../../scripts/checks/gate-por-tarea.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "gate-por-tarea-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Catálogo sintético de una sola categoría "money" apuntando a un archivo de prueba
 *  dentro del propio directorio temporal -- así la prueba controla exactamente si la
 *  "prueba correspondiente" existe o no, sin tocar el repo real. */
function reglaMoney(requiredTests: string[] = ["tests/money-determinism.spec.ts"]): CategoryRule[] {
  return [
    {
      id: "money-fixture",
      label: "dinero: fixture de prueba",
      gate: "money",
      pattern: /^src\/money\//,
      requiredTests,
    },
  ];
}

function reglaPhysical(requiredTests: string[] = ["tests/physical-lab.spec.ts"]): CategoryRule[] {
  return [
    {
      id: "physical-fixture",
      label: "control físico: fixture de prueba",
      gate: "physical",
      pattern: /^src\/locks\//,
      requiredTests,
    },
  ];
}

function escribirTarea(root: string, nombre: string, frontmatter: Record<string, string>): void {
  const lines = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", "", "# tarea de prueba", ""];
  writeFileSync(join(root, nombre), lines.join("\n"));
}

describe("parseTaskFrontmatter", () => {
  it("lee id/gate/paths separados por coma", () => {
    const contenido = ["---", "id: H-0231", "gate: money", "paths: src/money/a.ts, src/money/b.ts", "---", "", "# x"].join(
      "\n",
    );
    expect(parseTaskFrontmatter(contenido)).toEqual({
      id: "H-0231",
      gate: "money",
      paths: ["src/money/a.ts", "src/money/b.ts"],
    });
  });

  it("un archivo sin frontmatter devuelve todo null/vacío (no lanza)", () => {
    expect(parseTaskFrontmatter("# solo un título")).toEqual({ id: null, gate: null, paths: [] });
  });

  it("sin campo `paths` devuelve arreglo vacío, no undefined", () => {
    const contenido = ["---", "id: x", "gate: none", "---"].join("\n");
    expect(parseTaskFrontmatter(contenido).paths).toEqual([]);
  });
});

describe("checkGatePorTarea: escenario literal de ACEPTACION.md — 'PR con gate money sin la prueba correspondiente'", () => {
  it("gate=money declarado, paths tocan la categoría dinero, pero la prueba requerida NO existe -> 1 violación (bloquea)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0231-cobro-extra.md", {
      id: "H-0231",
      gate: "money",
      paths: "src/money/cobro.ts",
    });
    // Deliberadamente NO se crea tests/money-determinism.spec.ts -- el escenario exacto
    // que REQ-AGT-019 exige que CI bloquee.

    const violations = checkGatePorTarea(tasksDir, root, reglaMoney());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("H-0231");
    expect(violations[0]!.message).toContain("tests/money-determinism.spec.ts");
  });

  it("mismo caso, pero la prueba de determinismo de precio SÍ existe -> 0 violaciones (pasa)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "money-determinism.spec.ts"), "// prueba real de determinismo de precio\n");
    escribirTarea(tasksDir, "H-0231-cobro-extra.md", {
      id: "H-0231",
      gate: "money",
      paths: "src/money/cobro.ts",
    });

    const violations = checkGatePorTarea(tasksDir, root, reglaMoney());
    expect(violations).toHaveLength(0);
  });
});

describe("checkGatePorTarea: gate faltante o inválido", () => {
  it("tarea sin `gate` en el frontmatter -> violación explícita, no se cae en silencio", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0001.md", { id: "H-0001" });

    const violations = checkGatePorTarea(tasksDir, root, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no lleva `gate`/);
  });

  it(`tarea con gate fuera del catálogo cerrado (${VALID_GATES.join("/")}) -> violación`, () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0002.md", { id: "H-0002", gate: "inventado" });

    const violations = checkGatePorTarea(tasksDir, root, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/gate_invalido/);
  });
});

describe("checkGatePorTarea: gate debe coincidir con lo que los paths tocan", () => {
  it("paths tocan control físico pero gate declarado es `none` -> violación (nunca physical sin declarar)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0003.md", { id: "H-0003", gate: "none", paths: "src/locks/emitir-llave.ts" });

    const violations = checkGatePorTarea(tasksDir, root, reglaPhysical());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('exige gate "physical"');
  });

  it("paths tocan dinero pero gate declarado es `connector` (categoría equivocada) -> violación", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0004.md", { id: "H-0004", gate: "connector", paths: "src/money/cobro.ts" });

    const violations = checkGatePorTarea(tasksDir, root, reglaMoney());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no coincide/);
  });

  it("una tarea que mezcla dos categorías sensibles distintas en sus paths -> violación (debe dividirse)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0005.md", {
      id: "H-0005",
      gate: "money",
      paths: "src/money/cobro.ts, src/locks/emitir-llave.ts",
    });

    const violations = checkGatePorTarea(tasksDir, root, [...reglaMoney(), ...reglaPhysical()]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/mezclan más de una categoría/);
  });

  it("paths que NO tocan ninguna categoría sensible -> gate `none` es válido, 0 violaciones", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0006.md", { id: "H-0006", gate: "none", paths: "src/ui/boton.tsx" });

    const violations = checkGatePorTarea(tasksDir, root, [...reglaMoney(), ...reglaPhysical()]);
    expect(violations).toHaveLength(0);
  });
});

describe("checkGatePorTarea: comportamiento agregado y de entorno", () => {
  it("varias tareas en subcarpetas (tasks/hotel/**) se revisan todas, violaciones se acumulan", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(join(tasksDir, "hotel"), { recursive: true });
    escribirTarea(join(tasksDir, "hotel"), "H-0007.md", { id: "H-0007", gate: "money", paths: "src/money/a.ts" });
    escribirTarea(join(tasksDir, "hotel"), "H-0008.md", { id: "H-0008", gate: "none", paths: "src/locks/b.ts" });

    const violations = checkGatePorTarea(tasksDir, root, [...reglaMoney(), ...reglaPhysical()]);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.taskId).sort()).toEqual(["H-0007", "H-0008"]);
  });

  it("`_template.md` se ignora (es la plantilla, no una tarea real, GOB-045)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "_template.md", { id: "PLANTILLA", gate: "inventado" });

    const violations = checkGatePorTarea(tasksDir, root, []);
    expect(violations).toHaveLength(0);
  });

  it("un `tasks/` inexistente (backlog de archivos aún no materializado) no lanza y devuelve 0 violaciones", () => {
    const root = crearDirTemporal();
    const violations = checkGatePorTarea(join(root, "tasks-que-no-existe"), root, []);
    expect(violations).toHaveLength(0);
  });

  it("una tarea limpia con gate=connector y su contract test presente -> 0 violaciones", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "connector-contract.spec.ts"), "// contract test real\n");
    escribirTarea(tasksDir, "H-0009.md", { id: "H-0009", gate: "connector", paths: "src/pms/conector.ts" });

    const reglaConnector: CategoryRule[] = [
      {
        id: "connector-fixture",
        label: "agentes: conector PMS (fixture)",
        gate: "connector",
        pattern: /^src\/pms\//,
        requiredTests: ["tests/connector-contract.spec.ts"],
      },
    ];

    const violations = checkGatePorTarea(tasksDir, root, reglaConnector);
    expect(violations).toHaveLength(0);
  });
});
