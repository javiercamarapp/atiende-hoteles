// REQ-AGT-013 (LLM-023): "OCR de identidad/CFDI/recibos ejecutado con servicio dedicado
// autoalojado dentro del contenedor de la bóveda de identidad, sin salida a internet;
// grep/revisión de red confirma 0 llamadas a un LLM de canal o endpoint chino de
// primera parte para OCR." Prueba adversarial: inyecta código sintético que SÍ viola la
// regla (host chino real, y LLM de canal + vocabulario de OCR en el mismo archivo) y
// confirma que `checkOcrAisladoSinInternet` lo detecta -- nunca solo el caso feliz.
// Corre contra directorios temporales sintéticos (mismo patrón que
// tests/unit/gob/no-comandos-destructivos-agente.spec.ts), nunca contra el repo real,
// para no depender de ni poder romper su estado.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOcrAisladoSinInternet } from "../../../scripts/checks/ocr-aislado-sin-internet.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "ocr-aislado-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkOcrAisladoSinInternet", () => {
  it("detecta una llamada a un host chino de primera parte conocido (Zhipu/GLM)", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "ocr-adapter.ts"),
      'const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", { method: "POST" });\n',
    );
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("endpoint-chino-primera-parte");
    expect(violations[0]!.file).toBe("ocr-adapter.ts");
  });

  it("detecta Qwen/dashscope y PaddleOCR-cloud/baidubce como hosts distintos", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "a.ts"), 'fetch("https://dashscope.aliyuncs.com/api/v1/embeddings");\n');
    writeFileSync(join(root, "b.ts"), 'fetch("https://aip.baidubce.com/rest/2.0/ocr/v1/idcard");\n');
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations.map((v) => v.file).sort()).toEqual(["a.ts", "b.ts"]);
    expect(violations.every((v) => v.category === "endpoint-chino-primera-parte")).toBe(true);
  });

  it("detecta el LLM de canal (@atiende-hoteles/agent-core) usado en un archivo que también menciona OCR", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "identidad-ocr.ts"),
      'import { EnvProvider } from "@atiende-hoteles/agent-core";\n' +
        'export async function extraerDatosDocumentoOcr(imagenDocumento: string) { return imagenDocumento; }\n',
    );
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("llm-canal-usado-para-ocr");
    expect(violations[0]!.line).toBe(1);
  });

  it("NO marca el LLM de canal solo (sin vocabulario de OCR en el mismo archivo)", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "agentes.ts"),
      'import { EnvProvider } from "@atiende-hoteles/agent-core";\nexport function responderMensaje() {}\n',
    );
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO marca vocabulario de OCR solo (sin importar el LLM de canal)", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "mrz.ts"), "// esto NO es OCR -- valida el texto de la MRZ ya extraído\nexport function parseMrz() {}\n");
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO marca una línea de comentario que solo discute la regla (host chino en prosa)", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "README-ish.ts"),
      "// nunca llamar a open.bigmodel.cn ni a dashscope.aliyuncs.com para OCR\n" +
        "# tampoco desde un script comentado: aip.baidubce.com\n",
    );
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(0);
  });

  it("ignora migrations/ (mismo criterio que otros checks de este repo -- SQL, no código de red)", () => {
    const root = crearDirTemporal();
    const migrationsDir = join(root, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "0099_x.sql.ts"), '// fetch("https://open.bigmodel.cn")\n');
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(0);
  });

  it("un árbol limpio (sin llamadas prohibidas) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "identidad.ts"),
      'import { z } from "zod";\nconst schema = z.object({ mrzLine1: z.string(), mrzLine2: z.string() });\n',
    );
    const violations = checkOcrAisladoSinInternet([root], root);
    expect(violations).toHaveLength(0);
  });

  it("el árbol real del repo (apps/**, packages/**) no produce violaciones hoy", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const violations = checkOcrAisladoSinInternet([join(root, "apps"), join(root, "packages")], root);
    expect(violations).toHaveLength(0);
  });
});
