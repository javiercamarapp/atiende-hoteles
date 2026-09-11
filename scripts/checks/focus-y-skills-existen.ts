#!/usr/bin/env node
// REQ-AGT-021 (BP-136, BP-138) · revisión estática + operativa: "`FOCUS.md` por fase
// hotelera y skills hoteleras dedicadas (registro de fixtures PMS, laboratorio de
// edge, backtesting de revenue) documentadas y ejecutables (verificado: cada skill
// referenciada existe y su comando de ejecución corre sin error)."
//
// Dos verificaciones independientes:
//
//   1. FOCUS.md (BP-136): `docs/FOCUS.md` debe existir y ser parseable por
//      `parseFocusFile` (REQ-GOB-014, `packages/agent-core/src/backlog/backlogStateMachine.ts`)
//      -- frontmatter con `phase` no vacía y `openModules` con al menos un módulo. Este
//      check NO reimplementa ese parser (arriesgaría desincronizarse de la lógica real
//      que `selectNextTask` usa) -- lo importa y lo ejercita contra el archivo real.
//
//   2. Skills hoteleras (BP-138): "Deben existir skills hoteleras: `pms-fixture-record`,
//      `edge-lab`, `revenue-backtest` ... Cada skill ejecutable y documentada en
//      `.claude/skills/`." Para cada nombre requerido:
//        a. `.claude/skills/<nombre>/SKILL.md` debe existir con frontmatter `name`/
//           `description` (mismo formato que toda skill de Claude Code) y una sección
//           `## Comando de verificación` con un bloque de código de una sola línea.
//        b. Ese comando se EJECUTA de verdad (`execSync`, cwd = raíz del repo) y debe
//           salir con código 0 -- "corre sin error" es literal, no una lectura de que
//           el archivo exista nada más.
//
// Uso: `node scripts/checks/focus-y-skills-existen.ts` -- sale con código 1 e imprime
// el motivo si FOCUS.md no parsea o si falta/falla alguna skill requerida.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFocusFile, InvalidFocusFileError } from "../../packages/agent-core/src/backlog/backlogStateMachine.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const DEFAULT_FOCUS_FILE = join(ROOT, "docs", "FOCUS.md");
export const DEFAULT_SKILLS_DIR = join(ROOT, ".claude", "skills");

// BP-138 cita estos 3 nombres literalmente -- catálogo cerrado, no "cualquier skill que
// exista". Si el blueprint agrega una skill hotelera nueva en el futuro, se agrega aquí
// a propósito (nunca se infiere del contenido de `.claude/skills/`).
export const REQUIRED_SKILLS = ["pms-fixture-record", "edge-lab", "revenue-backtest"] as const;

export interface FocusCheckResult {
  readonly ok: boolean;
  readonly problem?: string;
}

export function checkFocusFile(focusFilePath: string = DEFAULT_FOCUS_FILE): FocusCheckResult {
  if (!existsSync(focusFilePath)) {
    return { ok: false, problem: `no existe ${focusFilePath} (BP-136 exige un FOCUS.md por fase hotelera).` };
  }
  const content = readFileSync(focusFilePath, "utf8");
  try {
    const focus = parseFocusFile(content);
    if (!focus.phase.trim()) {
      return { ok: false, problem: `${focusFilePath}: "phase" está vacía.` };
    }
    if (focus.openModules.length === 0) {
      return { ok: false, problem: `${focusFilePath}: "openModules" no tiene ningún módulo.` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof InvalidFocusFileError) {
      return { ok: false, problem: `${focusFilePath}: frontmatter inválido -- ${err.message}` };
    }
    throw err;
  }
}

export interface ParsedSkill {
  readonly name: string | null;
  readonly description: string | null;
  readonly verificationCommand: string | null;
}

/** Parseo mínimo de un SKILL.md: frontmatter YAML plano `clave: valor` (mismo patrón
 *  simplificado que `parseTaskFrontmatter` en `gate-por-tarea.ts`) + el primer bloque de
 *  código bajo el heading `## Comando de verificación`. */
export function parseSkillFile(content: string): ParsedSkill {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let name: string | null = null;
  let description: string | null = null;
  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1]!.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === "name") name = value;
      if (key === "description") description = value;
    }
  }

  const sectionMatch = content.match(/##\s*Comando de verificaci[oó]n[\s\S]*?```(?:bash|sh)?\n([\s\S]*?)```/);
  const verificationCommand = sectionMatch ? sectionMatch[1]!.trim() : null;

  return { name, description, verificationCommand };
}

export interface SkillViolation {
  readonly skill: string;
  readonly message: string;
}

export interface RunCommand {
  (command: string, cwd: string): void; // debe lanzar si el comando sale con código != 0.
}

const defaultRunCommand: RunCommand = (command, cwd) => {
  execSync(command, { cwd, stdio: "pipe" });
};

/** `skillsDir`/`runCommand` inyectables SOLO para pruebas (mismo patrón que
 *  `checkGatePorTarea` en `gate-por-tarea.ts`) -- el uso real (CLI) siempre apunta a
 *  `.claude/skills/` y ejecuta el comando de verdad con `execSync`. */
export function checkSkills(
  skillsDir: string = DEFAULT_SKILLS_DIR,
  requiredSkills: readonly string[] = REQUIRED_SKILLS,
  runCommand: RunCommand = defaultRunCommand,
): SkillViolation[] {
  const violations: SkillViolation[] = [];

  for (const skillName of requiredSkills) {
    const skillFile = join(skillsDir, skillName, "SKILL.md");
    if (!existsSync(skillFile)) {
      violations.push({ skill: skillName, message: `falta ${skillFile} (BP-138 exige esta skill documentada en .claude/skills/).` });
      continue;
    }

    const parsed = parseSkillFile(readFileSync(skillFile, "utf8"));

    if (parsed.name !== skillName) {
      violations.push({
        skill: skillName,
        message: `${skillFile}: el frontmatter "name" es "${parsed.name}", se esperaba "${skillName}".`,
      });
    }
    if (!parsed.description) {
      violations.push({ skill: skillName, message: `${skillFile}: falta "description" en el frontmatter.` });
    }
    if (!parsed.verificationCommand) {
      violations.push({
        skill: skillName,
        message: `${skillFile}: falta una sección "## Comando de verificación" con un bloque de código.`,
      });
      continue; // sin comando no hay nada más que ejecutar para esta skill.
    }

    try {
      runCommand(parsed.verificationCommand, ROOT);
    } catch (err) {
      const output = (err as { stderr?: Buffer; stdout?: Buffer; message?: string }).stderr?.toString().trim();
      violations.push({
        skill: skillName,
        message: `comando "${parsed.verificationCommand}" salió con error: ${output || (err as Error).message}`,
      });
    }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const problems: string[] = [];

  const focusResult = checkFocusFile();
  if (!focusResult.ok) problems.push(`FOCUS.md: ${focusResult.problem}`);

  const skillViolations = checkSkills();
  for (const v of skillViolations) problems.push(`skill "${v.skill}": ${v.message}`);

  if (problems.length > 0) {
    console.error(`REQ-AGT-021: ${problems.length} problema(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  console.log(
    `REQ-AGT-021 OK: docs/FOCUS.md parsea correctamente (fase vigente + módulos abiertos) y las ${REQUIRED_SKILLS.length} ` +
      `skills hoteleras requeridas (${REQUIRED_SKILLS.join(", ")}) existen en .claude/skills/, documentadas y ` +
      "con su comando de ejecución corriendo sin error.",
  );
  process.exit(0);
}
