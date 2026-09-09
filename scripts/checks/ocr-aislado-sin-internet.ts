#!/usr/bin/env node
// REQ-AGT-013 (LLM-023 -- ver docs/ARQUITECTURA.md, "Resolución de las 10
// contradicciones", punto #10) · revisión estática: el criterio de `docs/ACEPTACION.md`
// exige que "grep/revisión de red confirma 0 llamadas a un LLM de canal o endpoint
// chino de primera parte para OCR". Este script ES ese grep -- ejecutable y
// reproducible, no una promesa en prosa.
//
// Estado real del sistema al momento de escribir este check (ver
// `packages/domain-hotel/src/mrz.ts`, `apps/api/src/routes/identidad.ts`,
// `apps/api/src/routes/checkinOnline.ts`): NO existe todavía ningún servicio de OCR en
// este repo -- las rutas de identidad reciben el TEXTO de la MRZ ya extraído (nunca una
// imagen). El servicio de OCR autoalojado real (PaddleOCR-VL/GLM-OCR u homólogo) dentro
// del contenedor de la bóveda de identidad sigue **pendiente de una confirmación
// explícita y separada del fundador** antes de desplegarse en producción (LLM-023,
// distinta de -- y no incluida en -- la aprobación de la Opción C de ADR-006). Este
// script NO despliega ni activa ese servicio; solo vigila, de forma repetible, que
// nadie lo conecte por la puerta de atrás mientras la decisión sigue pendiente:
//
//   (a) Ningún archivo de código (fuera de `docs/`, comentarios y este mismo
//       directorio de checks) contiene el host de un endpoint de LLM/OCR chino de
//       primera parte con presencia real en internet -- los mismos proveedores que
//       LLM-023 nombra explícitamente (GLM/bigmodel.cn, Qwen/dashscope,
//       PaddleOCR-cloud/baidubce) más otros proveedores de OCR/LLM chinos de uso común
//       para documentos de identidad/recibos (Textin/Intsig, Tencent Cloud, Moonshot,
//       DeepSeek, MiniMax, Doubao/Volces).
//   (b) Ningún archivo que importe el LLM de canal (`@atiende-hoteles/agent-core` --
//       la única abstracción de proveedor de LLM conversacional de ADR-006/ADR-007,
//       ver `packages/agent-core/src/provider.ts`) menciona también vocabulario de
//       OCR/extracción de imagen de documentos de identidad en el mismo archivo -- es
//       la separación estructural exacta que el criterio exige (el LLM de canal jamás
//       debe ser el que "vea" la imagen de una identificación/CFDI/recibo; eso es
//       trabajo exclusivo del servicio de OCR dedicado y autoalojado).
//
// Uso: `node scripts/checks/ocr-aislado-sin-internet.ts` -- sale con código 1 si
// encuentra una coincidencia, imprimiendo archivo:línea y la categoría de violación.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_SCAN_DIRS = [join(ROOT, "apps"), join(ROOT, "packages")];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "checks", ".git", "migrations"]);

// Endpoints de LLM/OCR chinos de primera parte con presencia real en internet -- el
// nombre suelto del modelo ("qwen", "glm") es demasiado ruidoso (aparece en
// documentación/comentarios discutiéndolo, ver docs/ARQUITECTURA.md); se exige el HOST
// real de la API, que es lo que este requisito prohíbe llamar.
const CHINESE_ENDPOINT_HOSTS = [
  "bigmodel.cn", // Zhipu AI / GLM (incl. GLM-OCR, nombrado explícitamente en LLM-023)
  "dashscope.aliyuncs.com", // Alibaba / Qwen (incl. Qwen3-Embedding, Qwen-VL OCR)
  "aip.baidubce.com", // Baidu AI Cloud (incl. API de OCR)
  "baidubce.com",
  "aistudio.baidu.com", // PaddleOCR -- demo/API en la nube (PaddleOCR-VL, nombrado en LLM-023)
  "paddlepaddle.org.cn",
  "api.textin.com", // Intsig/Textin -- OCR de identidad/CFDI/recibos chino de uso común
  "textin.com",
  "tencentcloudapi.com", // Tencent Cloud OCR
  "api.moonshot.cn",
  "api.deepseek.com",
  "api.minimax.chat",
  "ark.cn-beijing.volces.com", // ByteDance Doubao
];
const CHINESE_ENDPOINT_PATTERN = new RegExp(CHINESE_ENDPOINT_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|"), "i");

// El LLM de canal es exclusivamente el que exporta @atiende-hoteles/agent-core -- ninguna
// otra ruta de este repo habla con un proveedor de LLM conversacional (ADR-006/ADR-007).
const CHANNEL_LLM_IMPORT_PATTERN = /@atiende-hoteles\/agent-core/;

// Vocabulario de OCR/extracción de imagen de documentos de identidad.
const OCR_KEYWORD_PATTERN =
  /\bocr\b|reconocimiento[ _-]?[oó]ptico|imagenidentidad|imagendocumento|imagencfdi|imagenrecibo|documentimage|identityimage|receiptimage|passportimage/i;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#");
}

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

export interface OcrAisladoViolation {
  file: string;
  line: number;
  text: string;
  category: "endpoint-chino-primera-parte" | "llm-canal-usado-para-ocr";
}

/** `scanDirs`/`relativeTo` son inyectables SOLO para pruebas (directorios temporales
 *  sintéticos, mismo patrón que `scripts/checks/no-comandos-destructivos-agente.ts`) --
 *  el uso real (CLI) siempre escanea el repo real vía los defaults. */
export function checkOcrAisladoSinInternet(
  scanDirs: string[] = DEFAULT_SCAN_DIRS,
  relativeTo: string = ROOT,
): OcrAisladoViolation[] {
  const violations: OcrAisladoViolation[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const raw = readFileSync(file, "utf8");
      const lines = raw.split("\n");
      const relFile = file.replace(relativeTo + "/", "");

      // (a) host de endpoint chino de primera parte, línea por línea (fuera de comentario).
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;
        if (CHINESE_ENDPOINT_PATTERN.test(line)) {
          violations.push({ file: relFile, line: idx + 1, text: line.trim(), category: "endpoint-chino-primera-parte" });
        }
      });

      // (b) el LLM de canal y vocabulario de OCR en el mismo archivo -- separación
      // estructural exigida por el criterio. Se ignoran líneas de comentario para
      // decidir si hay señal real de CÓDIGO (no solo prosa que discuta el tema, como
      // este mismo archivo o packages/domain-hotel/src/mrz.ts).
      const codeText = lines.filter((l) => !isCommentLine(l)).join("\n");
      const importsChannelLlm = CHANNEL_LLM_IMPORT_PATTERN.test(codeText);
      const mentionsOcr = OCR_KEYWORD_PATTERN.test(codeText);
      if (importsChannelLlm && mentionsOcr) {
        const importLineIdx = lines.findIndex((l) => !isCommentLine(l) && CHANNEL_LLM_IMPORT_PATTERN.test(l));
        violations.push({
          file: relFile,
          line: importLineIdx >= 0 ? importLineIdx + 1 : 1,
          text: "archivo importa el LLM de canal (@atiende-hoteles/agent-core) y también contiene vocabulario de OCR/extracción de documento -- el canal conversacional nunca debe ser el que procese la imagen.",
          category: "llm-canal-usado-para-ocr",
        });
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkOcrAisladoSinInternet();
  if (violations.length > 0) {
    console.error("REQ-AGT-013: se encontraron violaciones de aislamiento del OCR de identidad/CFDI/recibos:");
    for (const v of violations) {
      console.error(`  [${v.category}] ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }
  console.log(
    "REQ-AGT-013 OK: 0 llamadas a un LLM de canal o endpoint chino de primera parte para OCR en apps/** y packages/**.\n" +
      "Nota: esto confirma la invariante de aislamiento de red/canal como guardrail permanente, NO que el servicio de\n" +
      "OCR autoalojado real ya esté desplegado -- ese despliegue (PaddleOCR-VL/GLM-OCR u homólogo dentro del\n" +
      "contenedor de la bóveda de identidad) sigue pendiente de confirmación explícita del fundador (LLM-023, ver\n" +
      "docs/ARQUITECTURA.md, 'Resolución de las 10 contradicciones' #10).",
  );
  process.exit(0);
}
