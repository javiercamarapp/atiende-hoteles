// REQ-AGT-015 (LLM-011/LLM-012): "El LLM-juez de los evals debe procesar únicamente
// datos sintéticos generados por el simulador, nunca transcripciones de huéspedes
// reales." Corre contra directorios temporales sintéticos -- nunca contra el repo
// real (mismo patrón que tests/unit/gob/no-comandos-destructivos-agente.spec.ts) --
// para probar la lógica de detección REAL sin depender del estado del repo. Una
// suite final corre contra el repo real (scanDirs por default) para dejar en verde
// la evidencia que exige docs/ACEPTACION.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLlmJuezSoloSintetico } from "../../scripts/checks/llm-juez-solo-sintetico.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "llm-juez-solo-sintetico-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkLlmJuezSoloSintetico -- dirección (A): el juez toca un dato real", () => {
  it("detecta un archivo de juez (por nombre) que hace SQL crudo contra public.message", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "llmJuez.ts"),
      'export async function correr(db: unknown) {\n  return db.query("select body from public.message where hotel_id = $1", [1]);\n}\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.direccion).toBe("juez-toca-dato-real");
    expect(violations[0]!.file).toBe("llmJuez.ts");
  });

  it("detecta un archivo de juez (por export `evaluarConLLMJuez`) que importa routes/mensajeria", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "evals.ts"),
      'import { listarConversaciones } from "../api/routes/mensajeria.ts";\n\nexport function evaluarConLLMJuez(t: unknown) {\n  return t;\n}\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.direccion).toBe("juez-toca-dato-real");
    expect(violations[0]!.text).toContain("routes/mensajeria");
  });

  it("detecta un archivo de juez que importa un adaptador de WhatsApp NO marcado fake/simulado", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "judge.ts"),
      'import { WhatsappAdapter } from "../mcp-servers/whatsapp/src/adapters/whatsapp-adapter.ts";\n\nexport function correr() { return WhatsappAdapter; }\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.direccion).toBe("juez-toca-dato-real");
  });

  it("NO marca un archivo de juez que importa el adaptador FAKE de WhatsApp (dato simulado, no real)", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "llmJuez.ts"),
      'import { FakeWhatsappAdapter } from "../mcp-servers/whatsapp/src/adapters/fake-whatsapp-adapter.ts";\n\nexport function evaluarConLLMJuez() { return FakeWhatsappAdapter; }\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO marca un archivo de juez que solo recibe un escenario sintético del simulador", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "llmJuez.ts"),
      'import type { EscenarioSintetico } from "../simulador/tipos.ts";\n\nexport function evaluarConLLMJuez(e: EscenarioSintetico) {\n  return e.transcripcion.length > 0;\n}\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });
});

describe("checkLlmJuezSoloSintetico -- dirección (B): el dato real importa al juez", () => {
  it("detecta una ruta que consulta public.conversation e importa un símbolo 'Juez'", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "mensajeria.ts"),
      'import { evaluarConLLMJuez } from "../evals/llmJuez.ts";\n\nexport async function handler(db: unknown) {\n  const { rows } = await db.query("select * from public.conversation where hotel_id = $1", [1]);\n  return evaluarConLLMJuez(rows);\n}\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.direccion).toBe("dato-real-importa-juez");
  });

  it("NO marca una ruta que consulta public.message pero no importa nada relacionado con 'juez'", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "mensajeria.ts"),
      'import { z } from "zod";\n\nexport async function handler(db: unknown) {\n  return db.query("select * from public.message where hotel_id = $1", [1]);\n}\n',
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });
});

describe("checkLlmJuezSoloSintetico -- ruido / falsos positivos", () => {
  it("NO marca una línea de puro comentario que discute la regla", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "llmJuez.ts"),
      "// el juez NUNCA debe leer public.message ni public.conversation\n" +
        "export function evaluarConLLMJuez() { return true; }\n",
    );
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });

  it("un archivo sin relación ('juez'/'judge' ausente, sin tablas reales) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "motorPrecio.ts"), "export function calcularTotal(neto: number) {\n  return neto * 1.16;\n}\n");
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });

  it("ignora node_modules/dist dentro del directorio escaneado", () => {
    const root = crearDirTemporal();
    const nm = join(root, "node_modules", "algo");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "llmJuez.ts"), 'db.query("select * from public.message");\n');
    const violations = checkLlmJuezSoloSintetico([root], root);
    expect(violations).toHaveLength(0);
  });
});

describe("checkLlmJuezSoloSintetico -- repo real", () => {
  it("el repo real (scanDirs por default) tiene 0 violaciones -- ni el simulador ni el LLM-juez existen todavía como código", () => {
    const violations = checkLlmJuezSoloSintetico();
    expect(violations).toHaveLength(0);
  });
});
