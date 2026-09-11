#!/usr/bin/env node
// REQ-AGT-021 (BP-136, BP-138): "Deben existir skills hoteleras: `pms-fixture-record`,
// `edge-lab`, `revenue-backtest` ... Cada skill ejecutable y documentada en
// `.claude/skills/`." Este es el CLI real detrás de la skill `revenue-backtest`
// (`.claude/skills/revenue-backtest/SKILL.md`).
//
// Envuelve el módulo de dominio puro `walkForwardBacktest.ts` (REQ-REV-003) para que un
// operador pueda correr un backtest walk-forward desde línea de comandos, dado un
// archivo JSON con: la serie de fechas a cubrir, el `windowSpec` (trainDays/testDays/
// stepDays) y el ingreso YA CALCULADO del motor y del baseline para cada ventana
// resultante (`windowRevenues`, en el mismo orden que `buildWalkForwardWindows`
// produce). Este script NO inventa ni estima ningún ingreso -- ver el docstring de
// `walkForwardBacktest.ts` sobre por qué eso requeriría un modelo de elasticidad no
// verificable; el `_nota` del dataset de ejemplo (`fixtures/revenue-backtest-sample.json`)
// deja explícito que esos números son sintéticos, no de un hotel real.
//
// Uso:
//   node --experimental-strip-types scripts/skills/revenue-backtest.ts <archivo.json>
//   node --experimental-strip-types scripts/skills/revenue-backtest.ts   (usa el dataset
//     de ejemplo committeado, fixtures/revenue-backtest-sample.json)
//
// Código de salida: 0 si el backtest se pudo CALCULAR (sin importar si `passes` da
// true o false -- eso es un resultado de negocio, no un error del script); distinto de
// cero solo si el archivo de entrada es inválido o no se puede procesar.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWalkForwardWindows,
  evaluateWalkForwardBacktest,
  type CounterfactualMethod,
  type DailyPricingRecord,
  type WalkForwardBacktestResult,
  type WalkForwardWindowSpec,
} from "../../packages/domain-hotel/src/revenue/walkForwardBacktest.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const DEFAULT_INPUT = join(ROOT, "scripts", "skills", "fixtures", "revenue-backtest-sample.json");

export interface RevenueBacktestInput {
  readonly series: { readonly startDate: string; readonly endDate: string };
  readonly windowSpec: WalkForwardWindowSpec;
  readonly counterfactualMethod: CounterfactualMethod;
  readonly windowRevenues: ReadonlyArray<{ readonly engineRevenue: number; readonly baselineRevenue: number }>;
  readonly minWindows?: number;
  readonly minImprovementPct?: number;
  readonly minWindowWinRatio?: number;
}

function buildDailySeries(startDate: string, endDate: string): DailyPricingRecord[] {
  const series: DailyPricingRecord[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError(`serie_invalida: startDate/endDate deben ser fechas ISO válidas (recibido "${startDate}".."${endDate}")`);
  }
  while (cursor <= end) {
    series.push({ date: cursor.toISOString().slice(0, 10) });
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return series;
}

/** Construye las ventanas reales (sin fuga de datos) y las combina 1:1 con los ingresos
 *  ya calculados de `windowRevenues`, en el orden que `buildWalkForwardWindows`
 *  produce. Lanza si el conteo no coincide -- señal de que el `windowSpec`/serie del
 *  archivo de entrada no corresponde a la cantidad de ingresos declarados. */
export function runRevenueBacktest(input: RevenueBacktestInput): { windowCount: number; result: WalkForwardBacktestResult } {
  const series = buildDailySeries(input.series.startDate, input.series.endDate);
  const windows = buildWalkForwardWindows(series, input.windowSpec);

  if (windows.length !== input.windowRevenues.length) {
    throw new RangeError(
      `desajuste_ventanas: la serie+windowSpec produce ${windows.length} ventana(s) pero "windowRevenues" trae ${input.windowRevenues.length} entrada(s) -- deben coincidir 1:1.`,
    );
  }

  const evaluations = windows.map((window, i) => ({
    window,
    engineRevenue: input.windowRevenues[i]!.engineRevenue,
    baselineRevenue: input.windowRevenues[i]!.baselineRevenue,
  }));

  const result = evaluateWalkForwardBacktest({
    evaluations,
    counterfactualMethod: input.counterfactualMethod,
    minWindows: input.minWindows,
    minImprovementPct: input.minImprovementPct,
    minWindowWinRatio: input.minWindowWinRatio,
  });

  return { windowCount: windows.length, result };
}

function printReport(windowCount: number, result: WalkForwardBacktestResult): void {
  console.log(`revenue-backtest: ${windowCount} ventana(s) walk-forward evaluada(s) (método contrafactual: ${result.counterfactualMethod})`);
  console.log(`  ingreso motor total:    ${result.engineTotalRevenue.toFixed(2)}`);
  console.log(`  ingreso baseline total: ${result.baselineTotalRevenue.toFixed(2)}`);
  console.log(`  mejora:                 ${result.improvementPct.toFixed(2)}%`);
  console.log(`  ventanas ganadas:       ${result.windowsEngineWon}/${result.windowsEvaluated} (${(result.windowWinRatio * 100).toFixed(1)}%)`);
  console.log(`  PASA (listo para promover shadow->propone->autopilot según REQ-REV-003): ${result.passes ? "SÍ" : "NO"}`);
  if (!result.passes) {
    for (const reason of result.failureReasons) console.log(`    - ${reason}`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const inputPath = process.argv[2] ?? DEFAULT_INPUT;
  try {
    const raw = readFileSync(inputPath, "utf8");
    const input = JSON.parse(raw) as RevenueBacktestInput;
    const { windowCount, result } = runRevenueBacktest(input);
    printReport(windowCount, result);
    process.exit(0);
  } catch (err) {
    console.error(`revenue-backtest: error procesando "${inputPath}": ${(err as Error).message}`);
    process.exit(1);
  }
}
