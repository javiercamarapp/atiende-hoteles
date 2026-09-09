// REQ-AGT-018 (GOB-059/BP-141): "prohibido `if provider === X`/`if pms === X` fuera del
// registro central de conectores; CI debe fallar ante cualquier coincidencia fuera del
// registro." Corre contra directorios temporales sintéticos -- nunca contra el repo
// real (mismo patrón que tests/unit/gob/no-comandos-destructivos-agente.spec.ts), para
// no depender de ni poder romper el estado real del repo. La corrida real del check
// contra el repo real está documentada en docs/logs/REQ-AGT-018/ (evidencia con
// comando + salida, incluyendo la corrida con una violación deliberada), tal como
// exige el principio 1 de docs/ACEPTACION.md.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRegistroUnicoConectores } from "../../../../scripts/checks/registro-unico-conectores.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "registro-unico-conectores-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkRegistroUnicoConectores", () => {
  it("detecta 'if (provider === \"x\")' fuera del registro central", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "wiring.ts"), 'export function build(provider: string) {\n  if (provider === "cloudbeds") return 1;\n  return 0;\n}\n');
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("if");
    expect(violations[0]!.line).toBe(2);
  });

  it("detecta 'if (pms === \"x\")' con acceso a propiedad (config.pms)", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "wiring.ts"), 'function f(config: { pms: string }) {\n  if (config.pms === "mews") return 2;\n}\n');
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(1);
  });

  it("detecta 'else if (provider === ...)' además del primer 'if'", () => {
    const root = crearDirTemporal();
    writeFileSync(
      root + "/wiring.ts",
      'function f(provider: string) {\n  if (provider === "a") return 1;\n  else if (provider === "b") return 2;\n}\n',
    );
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(2);
  });

  it("detecta 'switch (provider)'/'switch (pms)' aunque no use '==='", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "wiring.ts"), 'function f(provider: string) {\n  switch (provider) {\n    case "cloudbeds": return 1;\n    default: return 0;\n  }\n}\n');
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("switch");
  });

  it("NO marca una línea de comentario que solo discute la regla", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "notas.ts"),
      '// nunca escribir `if (provider === "cloudbeds")` fuera del registro\n' + '// tampoco `switch (pms) { ... }`\n',
    );
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO produce falsos positivos con identificadores que solo contienen 'provider'/'pms' como substring (providerId, isPms)", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "wiring.ts"),
      'function f(providerId: string, isPms: boolean) {\n  if (providerId === "x") return 1;\n  if (isPms === true) return 2;\n}\n',
    );
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO marca el archivo declarado como registro central, aunque contenga el patrón", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "registry.ts"), 'export function lookup(provider: string) {\n  if (provider === "cloudbeds") return 1;\n}\n');
    const violations = checkRegistroUnicoConectores([root], root, new Set(["registry.ts"]));
    expect(violations).toHaveLength(0);
  });

  it("SÍ marca el mismo patrón en un archivo que NO está en la lista de registros centrales", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "otro.ts"), 'export function lookup(provider: string) {\n  if (provider === "cloudbeds") return 1;\n}\n');
    const violations = checkRegistroUnicoConectores([root], root, new Set(["registry.ts"]));
    expect(violations).toHaveLength(1);
  });

  it("ignora node_modules/dist anidados dentro de los directorios escaneados", () => {
    const root = crearDirTemporal();
    const nodeModules = join(root, "node_modules", "algo");
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(join(nodeModules, "index.ts"), 'if (provider === "cloudbeds") {}\n');
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(0);
  });

  it("un árbol limpio (sin bifurcación por proveedor) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "wiring.ts"),
      'import { PMS_CONNECTOR_REGISTRY } from "@atiende-hoteles/mcp-pms";\n' +
        'export function build(provider: string) {\n' +
        '  const entry = PMS_CONNECTOR_REGISTRY.find((e) => e.provider === provider);\n' +
        "  return entry;\n" +
        "}\n",
    );
    // Nota: `.find((e) => e.provider === provider)` NO es un `if`/`switch` -- es una
    // búsqueda DENTRO del registro (el patrón que sí se busca fomentar), así que no
    // debe marcarse. Esto documenta esa distinción con una prueba explícita.
    const violations = checkRegistroUnicoConectores([root], root);
    expect(violations).toHaveLength(0);
  });

  it("verificado contra el repo real: 0 violaciones hoy (evidencia repetible sin depender de docs/logs/)", () => {
    // Corre con los defaults reales (sin overrides) -- exactamente lo que ejecuta
    // `node scripts/checks/registro-unico-conectores.ts` en CI/local. Si esta prueba
    // falla, CI falla: es el mecanismo real de "CI debe fallar ante cualquier
    // coincidencia fuera del registro" que exige REQ-AGT-018, no solo un script que
    // hay que acordarse de correr aparte.
    const violations = checkRegistroUnicoConectores();
    expect(violations).toEqual([]);
  });
});
