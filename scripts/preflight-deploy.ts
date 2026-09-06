#!/usr/bin/env node
// H12b · LAUNCH-010/D-006: compuerta local previa a cualquier despliegue real. Corre
// TODO lo que se puede verificar sin credenciales/proyecto real, en orden de "falla
// rápido" (mismo criterio que ADR-009 y `.github/workflows/ci.yml`):
//   1. Variables de entorno requeridas presentes (contra `apps/api/.env.example` /
//      `apps/web/.env.example` como catálogo documentado).
//   2. Migraciones aplican desde cero (embedded-postgres efímero real, no PGlite).
//   3. `npm test` (unit + integración + adversarial).
//   4. `npm run build` (web + api).
//   5. Tamaño de bundle de `apps/web` dentro de presupuesto.
//   6. `npm audit --audit-level=high` (mismo umbral que CI).
//
// NUNCA se conecta a Supabase/Vercel/Fly reales -- todo corre contra
// `embedded-postgres` local y el filesystem de este repo. Ningún paso publica nada.
//
// Uso:
//   node --experimental-strip-types scripts/preflight-deploy.ts           # todos los pasos
//   node --experimental-strip-types scripts/preflight-deploy.ts --env-only  # solo el paso 1
//     (usado por la prueba automatizada, que no puede correr `npm test` dentro de sí misma)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Variables de entorno requeridas
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvRequirement {
  name: string;
  app: "apps/api" | "apps/web";
  motivo: string;
}

/** Solo las variables que `deploy/env-matrix.md` marca "Obligatoria en producción: Sí"
 *  -- NO todo `.env.example` (ese archivo también documenta variables opcionales con
 *  default, que un despliegue real puede omitir sin riesgo). */
export const REQUIRED_ENV_VARS: EnvRequirement[] = [
  { name: "JWT_SECRET", app: "apps/api", motivo: "Firma/verificación de sesión (REQ-SEG-013) -- sin default en producción." },
  { name: "CORS_ALLOWED_ORIGINS", app: "apps/api", motivo: "Lista blanca explícita, nunca '*' (auditoria-1/seguridad [MEDIO])." },
  { name: "SUPABASE_DB_HOST", app: "apps/api", motivo: "apps/api nunca arranca embedded-postgres en producción (ADR-003) -- ver apps/api/src/dbProduction.ts." },
  { name: "SUPABASE_DB_PASSWORD_APP", app: "apps/api", motivo: "Contraseña real de atiende_app (docs/runbooks/migracion-a-supabase.md paso 6), nunca el placeholder de la migración." },
  { name: "VITE_API_URL", app: "apps/web", motivo: "Sin ella, el panel no tiene a dónde conectarse (apps/web/src/lib/api.ts)." },
];

export function checkRequiredEnvVars(source: NodeJS.ProcessEnv = process.env): StepResult {
  const faltantes = REQUIRED_ENV_VARS.filter((v) => !source[v.name] || source[v.name]!.trim() === "");
  if (faltantes.length > 0) {
    return {
      name: "variables_de_entorno",
      ok: false,
      detail: `Faltan ${faltantes.length} variable(s) obligatoria(s): ${faltantes
        .map((v) => `${v.name} (${v.app}: ${v.motivo})`)
        .join("; ")}`,
    };
  }
  return { name: "variables_de_entorno", ok: true, detail: `Las ${REQUIRED_ENV_VARS.length} variables obligatorias están presentes.` };
}

/** Confirma que cada variable requerida está también DOCUMENTADA en el `.env.example`
 *  de su app -- evita que este script y `apps/*/.env.example` se desincronicen (una
 *  variable que el preflight exige pero nadie documentó en el `.env.example` real). */
export function checkEnvExamplesDocumentRequiredVars(): StepResult {
  const faltantes: string[] = [];
  for (const v of REQUIRED_ENV_VARS) {
    const examplePath = join(ROOT, v.app, ".env.example");
    if (!existsSync(examplePath)) {
      faltantes.push(`${v.app}/.env.example no existe`);
      continue;
    }
    const content = readFileSync(examplePath, "utf8");
    // Acepta la variable comentada (ej. "# SUPABASE_DB_HOST=") o activa -- lo que
    // importa es que el NOMBRE esté documentado, no que tenga un valor de ejemplo real.
    if (!new RegExp(`^#?\\s*${v.name}=`, "m").test(content)) {
      faltantes.push(`${v.name} no está documentada en ${v.app}/.env.example`);
    }
  }
  if (faltantes.length > 0) {
    return { name: "env_example_documentado", ok: false, detail: faltantes.join("; ") };
  }
  return { name: "env_example_documentado", ok: true, detail: "Todas las variables requeridas están documentadas en su .env.example." };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Migraciones desde cero
// ─────────────────────────────────────────────────────────────────────────────

export async function checkMigrationsFromScratch(): Promise<StepResult> {
  const { openEmbeddedPostgres, applyMigrations } = await import("@atiende-hoteles/db");
  const engine = await openEmbeddedPostgres();
  try {
    const result = await applyMigrations(engine.admin);
    return {
      name: "migraciones_desde_cero",
      ok: true,
      detail: `${result.applied.length} migración(es) aplicadas desde cero, 0 omitida por error.`,
    };
  } catch (err) {
    return { name: "migraciones_desde_cero", ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await engine.stop();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3-4-6. Comandos de shell (test/build/audit) -- cada uno un paso independiente
// ─────────────────────────────────────────────────────────────────────────────

function runShellStep(name: string, command: string, args: string[]): StepResult {
  try {
    const output = execFileSync(command, args, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    return { name, ok: true, detail: output.split("\n").slice(-5).join("\n") };
  } catch (err) {
    const asExecErr = err as { stdout?: string; stderr?: string; message: string };
    const tail = `${asExecErr.stdout ?? ""}\n${asExecErr.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
    return { name, ok: false, detail: tail || asExecErr.message };
  }
}

export function checkTests(): StepResult {
  return runShellStep("npm_test", "npm", ["test"]);
}

export function checkBuild(): StepResult {
  return runShellStep("npm_build", "npm", ["run", "build"]);
}

export function checkAudit(): StepResult {
  // Mismo umbral que .github/workflows/ci.yml "npm-audit": bloqueante solo en high/critical.
  return runShellStep("npm_audit", "npm", ["audit", "--audit-level=high"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Presupuesto de bundle (apps/web/dist)
// ─────────────────────────────────────────────────────────────────────────────

/** KB de JS SIN comprimir en `apps/web/dist/assets/*.js` -- default generoso sobre el
 *  tamaño medido el 2026-09-06 (~525 KB) para no romper con crecimiento normal de
 *  features, pero sí atrapar una regresión grande (ej. una librería pesada importada
 *  sin querer). Configurable vía `BUNDLE_BUDGET_KB` para ajustar sin editar código. */
export const DEFAULT_BUNDLE_BUDGET_KB = 900;

export function checkBundleBudget(budgetKb: number = Number(process.env.BUNDLE_BUDGET_KB ?? DEFAULT_BUNDLE_BUDGET_KB)): StepResult {
  const distAssets = join(ROOT, "apps", "web", "dist", "assets");
  if (!existsSync(distAssets)) {
    return { name: "presupuesto_bundle", ok: false, detail: `${distAssets} no existe -- corre el build antes de este paso.` };
  }
  const jsFiles = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
  const totalBytes = jsFiles.reduce((acc, f) => acc + statSync(join(distAssets, f)).size, 0);
  const totalKb = totalBytes / 1024;
  if (totalKb > budgetKb) {
    return {
      name: "presupuesto_bundle",
      ok: false,
      detail: `El JS de apps/web/dist (${totalKb.toFixed(1)} KB) excede el presupuesto de ${budgetKb} KB.`,
    };
  }
  return { name: "presupuesto_bundle", ok: true, detail: `JS de apps/web/dist: ${totalKb.toFixed(1)} KB (presupuesto: ${budgetKb} KB).` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orquestador
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const envOnly = process.argv.includes("--env-only");
  const steps: StepResult[] = [];

  steps.push(checkRequiredEnvVars());
  steps.push(checkEnvExamplesDocumentRequiredVars());

  // Falla rápido: si las variables de entorno no están, no tiene sentido gastar minutos
  // en build/test/migraciones (mismo criterio que ADR-009).
  const envFailed = steps.some((s) => !s.ok);

  if (!envOnly && !envFailed) {
    steps.push(await checkMigrationsFromScratch());
    steps.push(checkTests());
    steps.push(checkBuild());
    steps.push(checkBundleBudget());
    steps.push(checkAudit());
  }

  const logLines = steps.map((s) => `[${s.ok ? "OK" : "FALLÓ"}] ${s.name}\n${s.detail}\n`);
  const logPath = join(ROOT, "docs", "logs", `h12b-preflight-deploy-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, logLines.join("\n"), "utf8");

  for (const s of steps) {
    console.log(`[${s.ok ? "OK" : "FALLÓ"}] ${s.name}`);
    if (!s.ok) console.error(s.detail);
  }
  console.log(`\nLog completo: ${logPath}`);

  const ok = steps.every((s) => s.ok);
  if (!ok) {
    console.error("\npreflight-deploy: FALLÓ -- no publiques hasta corregir lo de arriba.");
    process.exitCode = 1;
    return;
  }
  console.log("\npreflight-deploy: OK -- todas las compuertas locales pasaron.");
}

if (process.argv[1] && process.argv[1].endsWith("preflight-deploy.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
