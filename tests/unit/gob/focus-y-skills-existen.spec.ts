// REQ-AGT-021 (BP-136, BP-138): "`FOCUS.md` por fase hotelera y skills hoteleras
// dedicadas (registro de fixtures PMS, laboratorio de edge, backtesting de revenue)
// documentadas y ejecutables (verificado: cada skill referenciada existe y su comando
// de ejecución corre sin error)." Dos bloques de pruebas, mismo patrón que
// tests/unit/gob/gate-por-tarea.spec.ts: (1) `checkFocusFile`/`parseSkillFile` contra
// contenido sintético en directorios temporales, controlando exactamente qué existe o
// no en disco; (2) `checkSkills()` sin overrides, una vez, contra el `.claude/skills/`
// REAL del repo -- si una skill requerida por BP-138 falta o su comando real falla, esa
// prueba puntual cae, igual que gate-por-tarea.spec.ts hace con el repo real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFocusFile,
  checkSkills,
  parseSkillFile,
  DEFAULT_FOCUS_FILE,
  REQUIRED_SKILLS,
  type RunCommand,
} from "../../../scripts/checks/focus-y-skills-existen.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "focus-y-skills-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkFocusFile", () => {
  it("acepta un FOCUS.md con phase y openModules válidos", () => {
    const base = crearDirTemporal();
    const file = join(base, "FOCUS.md");
    writeFileSync(file, "---\nphase: cierre-p0\nopenModules: AGT, GOB\n---\n\n# Foco\n", "utf8");
    expect(checkFocusFile(file)).toEqual({ ok: true });
  });

  it("rechaza cuando el archivo no existe", () => {
    const base = crearDirTemporal();
    const result = checkFocusFile(join(base, "no-existe.md"));
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no existe");
  });

  it("rechaza un FOCUS.md sin frontmatter (InvalidFocusFileError de parseFocusFile)", () => {
    const base = crearDirTemporal();
    const file = join(base, "FOCUS.md");
    writeFileSync(file, "# Foco sin frontmatter\n", "utf8");
    const result = checkFocusFile(file);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("frontmatter inválido");
  });

  it("rechaza un FOCUS.md con openModules vacío", () => {
    const base = crearDirTemporal();
    const file = join(base, "FOCUS.md");
    writeFileSync(file, "---\nphase: cierre-p0\nopenModules:\n---\n", "utf8");
    const result = checkFocusFile(file);
    expect(result.ok).toBe(false);
  });

  it("el docs/FOCUS.md real del repo parsea correctamente (sanity del archivo real)", () => {
    expect(checkFocusFile(DEFAULT_FOCUS_FILE)).toEqual({ ok: true });
  });
});

describe("parseSkillFile", () => {
  it("extrae name/description del frontmatter y el comando bajo 'Comando de verificación'", () => {
    const content =
      "---\nname: mi-skill\ndescription: hace algo util\n---\n\n# mi-skill\n\nTexto de uso.\n\n" +
      "## Comando de verificación\n\nPárrafo explicativo antes del bloque (mismo patrón real que los SKILL.md de este repo):\n\n" +
      "```bash\nnode --experimental-strip-types scripts/skills/mi-skill.ts\n```\n";
    const parsed = parseSkillFile(content);
    expect(parsed.name).toBe("mi-skill");
    expect(parsed.description).toBe("hace algo util");
    expect(parsed.verificationCommand).toBe("node --experimental-strip-types scripts/skills/mi-skill.ts");
  });

  it("devuelve verificationCommand null si no hay sección 'Comando de verificación'", () => {
    const parsed = parseSkillFile("---\nname: x\ndescription: y\n---\n\nSin esa sección.\n");
    expect(parsed.verificationCommand).toBeNull();
  });

  it("devuelve name/description null si no hay frontmatter", () => {
    const parsed = parseSkillFile("# Sin frontmatter\n");
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBeNull();
  });
});

describe("checkSkills (sintético, directorio temporal)", () => {
  it("sin violaciones cuando las 3 skills requeridas existen, con nombre/descripción/comando y el comando sale 0", () => {
    const base = crearDirTemporal();
    for (const name of REQUIRED_SKILLS) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(
        join(base, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: descripción de ${name}\n---\n\n## Comando de verificación\n\n\`\`\`bash\ntrue\n\`\`\`\n`,
        "utf8",
      );
    }
    const runCommand: RunCommand = vi.fn(); // nunca lanza -> éxito
    const violations = checkSkills(base, REQUIRED_SKILLS, runCommand);
    expect(violations).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(REQUIRED_SKILLS.length);
  });

  it("reporta una skill requerida faltante", () => {
    const base = crearDirTemporal();
    // Solo se crea la primera de las requeridas.
    mkdirSync(join(base, REQUIRED_SKILLS[0]!), { recursive: true });
    writeFileSync(
      join(base, REQUIRED_SKILLS[0]!, "SKILL.md"),
      `---\nname: ${REQUIRED_SKILLS[0]}\ndescription: d\n---\n\n## Comando de verificación\n\n\`\`\`bash\ntrue\n\`\`\`\n`,
      "utf8",
    );
    const violations = checkSkills(base, REQUIRED_SKILLS, vi.fn());
    const faltantes = violations.filter((v) => v.message.includes("falta"));
    expect(faltantes.length).toBe(REQUIRED_SKILLS.length - 1);
  });

  it("reporta cuando el frontmatter 'name' no coincide con el nombre de la skill", () => {
    const base = crearDirTemporal();
    const skillName = "edge-lab";
    mkdirSync(join(base, skillName), { recursive: true });
    writeFileSync(
      join(base, skillName, "SKILL.md"),
      `---\nname: nombre-equivocado\ndescription: d\n---\n\n## Comando de verificación\n\n\`\`\`bash\ntrue\n\`\`\`\n`,
      "utf8",
    );
    const violations = checkSkills(base, [skillName], vi.fn());
    expect(violations.some((v) => v.message.includes('se esperaba "edge-lab"'))).toBe(true);
  });

  it("reporta cuando falta la sección 'Comando de verificación' y NO ejecuta ningún comando", () => {
    const base = crearDirTemporal();
    const skillName = "edge-lab";
    mkdirSync(join(base, skillName), { recursive: true });
    writeFileSync(join(base, skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: d\n---\n\nSin comando.\n`, "utf8");
    const runCommand = vi.fn();
    const violations = checkSkills(base, [skillName], runCommand);
    expect(violations.some((v) => v.message.includes("Comando de verificación"))).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reporta cuando el comando de verificación falla (sale con error)", () => {
    const base = crearDirTemporal();
    const skillName = "edge-lab";
    mkdirSync(join(base, skillName), { recursive: true });
    writeFileSync(
      join(base, skillName, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: d\n---\n\n## Comando de verificación\n\n\`\`\`bash\nfalse\n\`\`\`\n`,
      "utf8",
    );
    const runCommand: RunCommand = () => {
      throw Object.assign(new Error("comando falló"), { stderr: Buffer.from("boom") });
    };
    const violations = checkSkills(base, [skillName], runCommand);
    expect(violations.some((v) => v.message.includes("salió con error") && v.message.includes("boom"))).toBe(true);
  });
});

describe("checkSkills contra el repo real (sin overrides)", () => {
  it("las 3 skills requeridas por BP-138 existen en .claude/skills/ y su comando real corre sin error", () => {
    // Sin overrides: usa DEFAULT_SKILLS_DIR real y ejecuta los comandos de verdad
    // (execSync) -- si alguna skill falta o su script real falla, esta prueba puntual
    // cae, igual que el patrón de tests/unit/gob/gate-por-tarea.spec.ts contra el repo
    // real hoy.
    const violations = checkSkills();
    expect(violations).toEqual([]);
  }, 30_000);
});
