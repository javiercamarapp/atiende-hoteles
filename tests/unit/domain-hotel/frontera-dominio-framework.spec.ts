// Patrón Likida/atiende.ai #2: "packages/domain-hotel (dominio puro) nunca debe
// importar hono/express/node:http ni ningún paquete de apps/*; CI debe fallar ante
// cualquier coincidencia." Corre contra directorios temporales sintéticos -- nunca
// contra el repo real para las pruebas de detección (mismo patrón que
// tests/unit/mcp-servers/pms/registro-unico-conectores.spec.ts); la última prueba SÍ
// corre contra el repo real, con los defaults, para que un CI real falle si algo lo
// rompe después.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFronteraDominioFramework, isForbiddenSpecifier } from "../../../scripts/checks/frontera-dominio-framework.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "frontera-dominio-framework-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("isForbiddenSpecifier", () => {
  it("marca 'hono' exacto y sus submódulos ('hono/cors')", () => {
    expect(isForbiddenSpecifier("hono")).toBe(true);
    expect(isForbiddenSpecifier("hono/cors")).toBe(true);
  });

  it("marca cualquier paquete con scope '@hono/*'", () => {
    expect(isForbiddenSpecifier("@hono/zod-validator")).toBe(true);
    expect(isForbiddenSpecifier("@hono/node-server")).toBe(true);
  });

  it("marca 'express' y 'node:http'/'node:https'", () => {
    expect(isForbiddenSpecifier("express")).toBe(true);
    expect(isForbiddenSpecifier("node:http")).toBe(true);
    expect(isForbiddenSpecifier("node:https")).toBe(true);
  });

  it("marca los paquetes publicados de apps/* por nombre", () => {
    expect(isForbiddenSpecifier("@atiende-hoteles/api")).toBe(true);
    expect(isForbiddenSpecifier("@atiende/web")).toBe(true);
  });

  it("marca una ruta relativa que alcanza un directorio 'apps/'", () => {
    expect(isForbiddenSpecifier("../../../apps/api/src/types.ts")).toBe(true);
  });

  it("NO marca 'zod' ni un import relativo dentro del propio paquete", () => {
    expect(isForbiddenSpecifier("zod")).toBe(false);
    expect(isForbiddenSpecifier("./quote.ts")).toBe(false);
    expect(isForbiddenSpecifier("../tickets/slaPolicy.ts")).toBe(false);
  });

  it("NO produce falso positivo con un paquete cuyo nombre solo CONTIENE 'hono'/'express' como substring", () => {
    expect(isForbiddenSpecifier("mi-hono-utils")).toBe(false);
    expect(isForbiddenSpecifier("expression-parser")).toBe(false);
  });
});

describe("checkFronteraDominioFramework", () => {
  it("detecta 'import { Hono } from \"hono\"' con file:line correctos", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "wiring.ts"), 'import { Hono } from "hono";\n\nexport const app = new Hono();\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(1);
    expect(violations[0]!.specifier).toBe("hono");
  });

  it("detecta 'import type { Context } from \"hono\"' (import de solo-tipo, también prohibido)", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "tipos.ts"), 'import type { Context } from "hono";\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(1);
  });

  it("detecta un import dinámico 'import(\"express\")'", () => {
    const root = crearDirTemporal();
    writeFileSync(root + "/dinamico.ts", 'export async function cargar() {\n  return import("express");\n}\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe("express");
  });

  it("detecta 'require(\"node:http\")'", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "legacy.ts"), 'const http = require("node:http");\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe("node:http");
  });

  it("detecta un import de un paquete de apps/* (@atiende-hoteles/api)", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "fuga.ts"), 'import type { AppDeps } from "@atiende-hoteles/api";\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(1);
  });

  it("NO marca una línea de comentario que solo discute la regla", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "notas.ts"), '// nunca hacer `import { Hono } from "hono"` aquí\n// tampoco `require("express")`\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(0);
  });

  it("un árbol de dominio puro (solo zod + imports relativos) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "quote.ts"),
      'import { z } from "zod";\nimport { computeSlaDueAt } from "./tickets/slaPolicy.ts";\n\nexport const schema = z.object({});\n',
    );
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(0);
  });

  it("ignora node_modules/dist anidados dentro del directorio escaneado", () => {
    const root = crearDirTemporal();
    const nodeModules = join(root, "node_modules", "algo");
    const dist = join(root, "dist");
    mkdirSync(nodeModules, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(nodeModules, "index.ts"), 'import { Hono } from "hono";\n');
    writeFileSync(join(dist, "index.ts"), 'import { Hono } from "hono";\n');
    writeFileSync(join(root, "sano.ts"), 'import { z } from "zod";\n');
    const violations = checkFronteraDominioFramework(root, root);
    expect(violations).toHaveLength(0);
  });

  it("verificado contra el repo real: 0 violaciones hoy en packages/domain-hotel/src (evidencia repetible sin depender de docs/logs/)", () => {
    // Corre con los defaults reales (sin overrides) -- exactamente lo que ejecuta
    // `node scripts/checks/frontera-dominio-framework.ts` en CI/local. Si esta prueba
    // falla, CI falla.
    const violations = checkFronteraDominioFramework();
    expect(violations).toEqual([]);
  });
});
