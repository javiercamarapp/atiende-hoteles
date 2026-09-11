#!/usr/bin/env node
// REQ-AGT-021 (BP-136, BP-138): "Deben existir skills hoteleras: `pms-fixture-record`,
// `edge-lab`, `revenue-backtest` ... Cada skill ejecutable y documentada en
// `.claude/skills/`." Este es el CLI real detrás de la skill `pms-fixture-record`
// (`.claude/skills/pms-fixture-record/SKILL.md`).
//
// Problema que resuelve: antes de este archivo, los fixtures de Cloudbeds vivían
// hardcodeados dentro del propio adaptador falso (`FIXTURE_RESERVATIONS` en
// `packages/mcp-servers/pms/src/adapters/fake-cloudbeds-adapter.ts`) -- útiles para el
// contract test, pero sin un registro versionado, inspeccionable y regenerable de
// verdad contra el CONTRATO HTTP documentado (`CloudbedsSimulator`,
// `packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts`). Este script SÍ graba
// tráfico HTTP real contra un servidor real en localhost (el simulador ya usado por
// `contract.spec.ts`) -- nunca inventa un payload a mano.
//
// Tres subcomandos:
//   record   -- levanta `CloudbedsSimulator` en un puerto efímero real, ejecuta la
//               secuencia canónica de llamadas documentada abajo (auth + los 6
//               endpoints que el simulador implementa) y escribe cada intercambio
//               request/response como un fixture JSON en `fixtures/`. Determinista
//               salvo `recordedAt` (timestamp) y el token/uuid emitidos por el
//               simulador -- cualquier otra diferencia entre corridas indica una
//               regresión real en el contrato.
//   validate -- lee los fixtures ya versionados en el repo y verifica su forma mínima
//               (sin red, sin levantar el simulador) -- es el comando rápido y
//               determinista que corre en CI (ver `scripts/checks/focus-y-skills-existen.ts`).
//   list     -- lista los fixtures presentes con su endpoint/status, para inspección
//               humana rápida.
//
// Uso:
//   node --experimental-strip-types scripts/skills/pms-fixture-record.ts validate
//   node --experimental-strip-types scripts/skills/pms-fixture-record.ts list
//   node --experimental-strip-types scripts/skills/pms-fixture-record.ts record
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CloudbedsSimulator } from "../../packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const DEFAULT_FIXTURES_DIR = join(ROOT, "packages", "mcp-servers", "pms", "fixtures");

export interface PmsFixture {
  readonly source: "cloudbeds-simulator";
  readonly recordedAt: string;
  readonly endpoint: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly response: { readonly status: number; readonly body: unknown };
}

const REQUIRED_FIXTURE_KEYS = ["source", "recordedAt", "endpoint", "request", "response"] as const;

/** Validación estructural mínima de un fixture ya leído del disco -- deliberadamente NO
 *  revalida el contrato HTTP completo (eso es responsabilidad de `contract.spec.ts`
 *  contra el simulador real); solo confirma que el archivo tiene la forma que
 *  `record` produce, para detectar un fixture corrupto o editado a mano de forma
 *  incompleta. */
export function validateFixtureShape(file: string, data: unknown): string[] {
  const problems: string[] = [];
  if (typeof data !== "object" || data === null) {
    return [`${file}: no es un objeto JSON.`];
  }
  const obj = data as Record<string, unknown>;
  for (const key of REQUIRED_FIXTURE_KEYS) {
    if (!(key in obj)) problems.push(`${file}: falta el campo "${key}".`);
  }
  if (obj.source !== "cloudbeds-simulator") {
    problems.push(`${file}: "source" debe ser "cloudbeds-simulator" (recibido: ${JSON.stringify(obj.source)}).`);
  }
  const request = obj.request as Record<string, unknown> | undefined;
  if (request && (typeof request.method !== "string" || typeof request.path !== "string")) {
    problems.push(`${file}: "request.method"/"request.path" deben ser strings.`);
  }
  const response = obj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status !== "number") {
    problems.push(`${file}: "response.status" debe ser un número.`);
  }
  return problems;
}

export function listFixtures(dir: string = DEFAULT_FIXTURES_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function validateFixtures(dir: string = DEFAULT_FIXTURES_DIR): { file: string; problems: string[] }[] {
  const results: { file: string; problems: string[] }[] = [];
  for (const file of listFixtures(dir)) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      results.push({ file, problems: [`${file}: JSON inválido (${(err as Error).message}).`] });
      continue;
    }
    const problems = validateFixtureShape(file, data);
    if (problems.length > 0) results.push({ file, problems });
  }
  return results;
}

/** Ejecuta la secuencia canónica de llamadas contra un `CloudbedsSimulator` real (ya
 *  arrancado) y devuelve un fixture por endpoint. No usa `fetch` con reintentos ni
 *  backoff -- este script graba el contrato, no ejercita la resiliencia del adaptador
 *  (eso ya lo hace `contract.spec.ts` con `CloudbedsAdapter` real). */
async function recordAgainstSimulator(sim: CloudbedsSimulator): Promise<PmsFixture[]> {
  const base = sim.url();
  const recordedAt = new Date().toISOString();
  const fixtures: PmsFixture[] = [];

  const tokenRes = await fetch(`${base}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: sim.currentRefreshToken(),
      client_id: "sim-client-id",
      client_secret: "sim-client-secret",
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token: string };
  fixtures.push({
    source: "cloudbeds-simulator",
    recordedAt,
    endpoint: "access_token",
    request: { method: "POST", path: "/access_token" },
    response: { status: tokenRes.status, body: tokenBody },
  });
  const accessToken = tokenBody.access_token;
  const auth = { Authorization: `Bearer ${accessToken}` };

  const calls: { endpoint: string; method: string; path: string; init?: RequestInit }[] = [
    { endpoint: "getReservation", method: "GET", path: "/getReservation?reservationID=SIM-RES-1" },
    { endpoint: "getGuest", method: "GET", path: "/getGuest?reservationID=SIM-RES-1" },
    { endpoint: "getRatePlans", method: "GET", path: "/getRatePlans?roomTypeID=SIM-RT-STD&startDate=2026-10-10&endDate=2026-10-13" },
    {
      endpoint: "postCharge",
      method: "POST",
      path: "/postCharge",
      init: {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ reservationID: "SIM-RES-1", amount: "500", type: "custom" }),
      },
    },
    {
      endpoint: "postHousekeepingStatus",
      method: "POST",
      path: "/postHousekeepingStatus",
      init: {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ roomID: "SIM-RT-STD-101", roomCondition: "clean" }),
      },
    },
    { endpoint: "getCurrencySettings", method: "GET", path: "/getCurrencySettings" },
  ];

  for (const call of calls) {
    const res = await fetch(`${base}${call.path}`, call.init ?? { headers: auth });
    const body = await res.json();
    fixtures.push({
      source: "cloudbeds-simulator",
      recordedAt,
      endpoint: call.endpoint,
      request: { method: call.method, path: call.path },
      response: { status: res.status, body },
    });
  }

  return fixtures;
}

async function runRecord(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const sim = new CloudbedsSimulator();
  await sim.start();
  try {
    const fixtures = await recordAgainstSimulator(sim);
    for (const fixture of fixtures) {
      const file = join(outDir, `${fixture.endpoint}.json`);
      writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n", "utf8");
      console.log(`grabado: ${file} (status ${fixture.response.status})`);
    }
    console.log(`pms-fixture-record OK: ${fixtures.length} fixture(s) grabado(s) en ${outDir}`);
  } finally {
    await sim.stop();
  }
}

function runValidate(dir: string): void {
  const found = listFixtures(dir);
  if (found.length === 0) {
    console.error(`pms-fixture-record: 0 fixtures en ${dir} -- corre "record" primero.`);
    process.exit(1);
  }
  const failures = validateFixtures(dir);
  if (failures.length > 0) {
    console.error(`pms-fixture-record: ${failures.length} fixture(s) con problemas:`);
    for (const f of failures) {
      for (const p of f.problems) console.error(`  ${p}`);
    }
    process.exit(1);
  }
  console.log(`pms-fixture-record OK: ${found.length} fixture(s) válido(s) en ${dir}: ${found.join(", ")}`);
}

function runList(dir: string): void {
  const found = listFixtures(dir);
  if (found.length === 0) {
    console.log(`pms-fixture-record: 0 fixtures en ${dir}.`);
    return;
  }
  for (const file of found) {
    const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as PmsFixture;
    console.log(`${file}: endpoint=${data.endpoint} status=${data.response.status} recordedAt=${data.recordedAt}`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , subcommand, ...rest] = process.argv;
  const outFlagIdx = rest.indexOf("--out");
  // `resolve` (a diferencia de `join`) respeta un `--out` ya absoluto en vez de
  // concatenarlo con cwd -- necesario para que las pruebas puedan apuntar a un
  // directorio temporal absoluto sin depender de con qué cwd se invocó el proceso.
  const dir = outFlagIdx !== -1 && rest[outFlagIdx + 1] ? resolve(process.cwd(), rest[outFlagIdx + 1]!) : DEFAULT_FIXTURES_DIR;

  switch (subcommand) {
    case "record":
      await runRecord(dir);
      break;
    case "validate":
      runValidate(dir);
      break;
    case "list":
      runList(dir);
      break;
    default:
      console.error("Uso: pms-fixture-record.ts <record|validate|list> [--out <dir>]");
      process.exit(1);
  }
}
