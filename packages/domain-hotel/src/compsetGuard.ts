// H4 · REQ-REV-004: el motor de revenue NO debe usar tarifas/ocupación no públicas de
// un solo hotel-cliente competidor. Cualquier agregado de red exige k≥10 hoteles,
// ≥12 meses de histórico y una opinión antimonopolio documentada — esta función es la
// única puerta por la que una consulta de benchmarking de compset podría avanzar; no
// existe ninguna otra ruta de código que agregue datos de competidores (H4 no
// construye el motor de revenue-benchmarking en sí, solo esta guarda negativa).
export class BenchmarkGuardError extends Error {
  code = "benchmark_k_minimo";
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkGuardError";
  }
}

export interface BenchmarkQueryRequest {
  /** Número de hoteles competidores distintos incluidos en el agregado (k). */
  competitorCount: number;
  monthsOfHistory: number;
  hasAntitrustOpinion: boolean;
}

const MIN_COMPETITORS = 10;
const MIN_MONTHS_HISTORY = 12;

export function assertBenchmarkQueryAllowed(req: BenchmarkQueryRequest): void {
  if (req.competitorCount < MIN_COMPETITORS) {
    throw new BenchmarkGuardError(
      `Se requieren al menos ${MIN_COMPETITORS} hoteles competidores en el agregado (recibidos: ${req.competitorCount}).`,
    );
  }
  if (req.monthsOfHistory < MIN_MONTHS_HISTORY) {
    throw new BenchmarkGuardError(
      `Se requieren al menos ${MIN_MONTHS_HISTORY} meses de histórico (recibidos: ${req.monthsOfHistory}).`,
    );
  }
  if (!req.hasAntitrustOpinion) {
    throw new BenchmarkGuardError(
      "Se requiere una opinión antimonopolio documentada antes de agregar datos de competidores.",
    );
  }
}
