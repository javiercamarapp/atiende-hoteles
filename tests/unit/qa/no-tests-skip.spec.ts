// REQ-QA-002 (GOB-012): "Nunca se debe comentar, borrar ni marcar `skip` una prueba
// existente; ante un caso que no pasa, se crea una prueba adicional para cubrirlo en
// verde." Prueba adversarial: inyecta código sintético que SÍ viola la regla (formas
// prohibidas de deshabilitar una prueba) y confirma que `checkNoTestsSkip` lo detecta
// -- nunca solo el caso feliz -- y confirma también que las dos formas LEGÍTIMAS ya
// presentes en el repo real (skip condicional por proyecto de Playwright, skip
// incondicional con motivo nombrado) NO se marcan como violación. Corre contra
// directorios temporales sintéticos (mismo patrón que
// tests/unit/gob/pms-mirror-solo-lectura.spec.ts), nunca contra el repo real para los
// casos negativos; el último bloque SÍ corre contra `tests/` real para confirmar que
// hoy cierra en verde.
//
// Nota de implementación de ESTA prueba (no del check): las líneas de fixture que
// contienen las formas prohibidas se construyen concatenando fragmentos de cadena en
// vez de escribir el texto contiguo -- si este archivo (que vive bajo `tests/`, así
// que el propio check lo escanea) contuviera literalmente "xit(" o "it.skip(" como
// texto plano contiguo, el check real se marcaría una falsa violación a sí mismo la
// próxima vez que corriera contra el árbol real. Concatenar evita esa autorreferencia
// sin cambiar el valor de cadena que de verdad se escribe en el archivo temporal.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNoTestsSkip } from "../../../scripts/checks/no-tests-skip.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "no-tests-skip-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

// Fragmentos concatenados en vez de literales contiguos -- ver nota arriba.
const cat = (...parts: string[]) => parts.join("");
const XIT_LLAMADA = cat("x", "it(");
const XDESCRIBE_LLAMADA = cat("x", "describe(");
const IT_SKIP_LLAMADA = cat("it", ".", "skip(");
const DESCRIBE_SKIP_LLAMADA = cat("describe", ".", "skip(");
const TEST_SKIP_LLAMADA = cat("test", ".", "skip(");

function crearArchivo(root: string, relPath: string, contenido: string): void {
  const full = join(root, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contenido);
}

describe("checkNoTestsSkip", () => {
  it("directorio sin ninguna forma prohibida: 0 violaciones y 0 permitidos", () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/unit/limpio.spec.ts", 'it("hace algo", () => { expect(1).toBe(1); });\n');
    const { violations, allowed } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(0);
    expect(allowed).toHaveLength(0);
  });

  it(`detecta ${XIT_LLAMADA}...) fuera de tests/e2e/`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/unit/malo.spec.ts", `${XIT_LLAMADA}"caso ignorado", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("xit-prohibido");
    expect(violations[0]!.file).toBe("tests/unit/malo.spec.ts");
  });

  it(`detecta ${XDESCRIBE_LLAMADA}...) fuera de tests/e2e/`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/unit/malo.spec.ts", `${XDESCRIBE_LLAMADA}"grupo ignorado", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("xdescribe-prohibido");
  });

  it(`detecta ${IT_SKIP_LLAMADA}...) fuera de tests/e2e/`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/integration/malo.spec.ts", `${IT_SKIP_LLAMADA}"caso", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("it-o-describe-skip-prohibido");
  });

  it(`detecta ${DESCRIBE_SKIP_LLAMADA}...) fuera de tests/e2e/`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/adversarial/malo.spec.ts", `${DESCRIBE_SKIP_LLAMADA}"grupo", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("it-o-describe-skip-prohibido");
  });

  it(`${IT_SKIP_LLAMADA}...) también se prohíbe DENTRO de tests/e2e/ -- solo test.skip tiene forma reconocida`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/e2e/malo.spec.ts", `${IT_SKIP_LLAMADA}"caso", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("it-o-describe-skip-prohibido");
  });

  it(`detecta ${TEST_SKIP_LLAMADA}...) fuera de tests/e2e/, aunque declare un motivo`, () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/unit/malo.spec.ts", `${TEST_SKIP_LLAMADA}true, "tiene motivo pero no es Playwright");\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toBe("test-skip-fuera-de-e2e");
  });

  describe(`${TEST_SKIP_LLAMADA}...) dentro de tests/e2e/`, () => {
    it("se PERMITE con condición + motivo string no vacío (patrón real: skip por proyecto)", () => {
      const root = crearDirTemporal();
      crearArchivo(
        root,
        "tests/e2e/bueno.spec.ts",
        `${TEST_SKIP_LLAMADA}testInfo.project.name !== "desktop", "una sola corrida basta");\n`,
      );
      const { violations, allowed } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(0);
      expect(allowed).toHaveLength(1);
      expect(allowed[0]!.motivo).toBe('"una sola corrida basta"');
    });

    it("se PERMITE con condición true + motivo como variable nombrada (patrón real: motivoFallo)", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/bueno.spec.ts", `${TEST_SKIP_LLAMADA}true, motivoFallo);\n`);
      const { violations, allowed } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(0);
      expect(allowed).toHaveLength(1);
      expect(allowed[0]!.motivo).toBe("motivoFallo");
    });

    it("se PROHÍBE sin ningún argumento (skip incondicional sin motivo)", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/malo.spec.ts", `${TEST_SKIP_LLAMADA});\n`);
      const { violations } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("test-skip-sin-motivo-documentado");
    });

    it("se PROHÍBE con un solo argumento (condición sin motivo)", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/malo.spec.ts", `${TEST_SKIP_LLAMADA}true);\n`);
      const { violations } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("test-skip-sin-motivo-documentado");
    });

    it("se PROHÍBE con motivo de cadena vacía (intento de evadir el check con \"\")", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/malo.spec.ts", `${TEST_SKIP_LLAMADA}true, "");\n`);
      const { violations } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("test-skip-sin-motivo-documentado");
    });

    it("se trata como violación (falla cerrado) si los paréntesis no cierran en la misma línea", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/malo.spec.ts", `${TEST_SKIP_LLAMADA}\n  true,\n  "motivo en otra línea",\n);\n`);
      const { violations } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.category).toBe("test-skip-multilinea-no-verificable");
    });

    it("respeta una coma DENTRO del motivo entre comillas al separar argumentos", () => {
      const root = crearDirTemporal();
      crearArchivo(root, "tests/e2e/bueno.spec.ts", `${TEST_SKIP_LLAMADA}true, "motivo, con coma, real");\n`);
      const { violations, allowed } = checkNoTestsSkip(root, root);
      expect(violations).toHaveLength(0);
      expect(allowed[0]!.motivo).toBe('"motivo, con coma, real"');
    });
  });

  it("una línea que es puro comentario no cuenta como violación (prosa, no código ejecutable)", () => {
    const root = crearDirTemporal();
    crearArchivo(root, "tests/unit/comentado.spec.ts", `// ${XIT_LLAMADA}"esto es solo un comentario", () => {});\n`);
    const { violations } = checkNoTestsSkip(root, root);
    expect(violations).toHaveLength(0);
  });

  it("corre contra tests/ del repo real y confirma 0 violaciones, con los 5 skips condicionales conocidos permitidos", () => {
    const { violations, allowed } = checkNoTestsSkip();
    expect(violations).toHaveLength(0);
    // Se comprueba por CONTENIDO (no por longitud exacta) porque este working tree
    // puede recibir ediciones concurrentes de otras sesiones sobre tests/e2e/ mientras
    // esta prueba corre (ya documentado en docs/PROGRESO.md) -- no se quiere una
    // prueba frágil que falle por trabajo ajeno legítimo, solo por una regresión real
    // de ESTE check.
    const archivosConSkipConocido = [
      "tests/e2e/login-real-y-resumen.spec.ts",
      "tests/e2e/paridad-restaurantes-login.spec.ts",
      "tests/e2e/paridad-visual.spec.ts",
    ];
    for (const archivo of archivosConSkipConocido) {
      expect(allowed.some((a) => a.file === archivo)).toBe(true);
    }
  });
});
