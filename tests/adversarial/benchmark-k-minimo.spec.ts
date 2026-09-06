// REQ-REV-004: el motor de revenue NO debe usar tarifas/ocupación no públicas de un
// solo hotel-cliente competidor; cualquier agregado de red exige k≥10 hoteles, ≥12
// meses de histórico y una opinión antimonopolio documentada. H4 no construye el motor
// de benchmarking en sí (fuera de alcance, ver packages/domain-hotel/README.md) — esta
// es la guarda negativa que cualquier futura implementación DEBE atravesar primero.
import { describe, expect, it } from "vitest";
import { assertBenchmarkQueryAllowed, BenchmarkGuardError } from "@atiende-hoteles/domain-hotel";

describe("adversarial: guarda de benchmarking de compset (REQ-REV-004)", () => {
  it("k=9 (menor al mínimo de 10) es rechazada, incluso con histórico y opinión antimonopolio en regla", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 9, monthsOfHistory: 24, hasAntitrustOpinion: true }),
    ).toThrow(BenchmarkGuardError);
  });

  it("k=1 (un solo hotel-cliente competidor, el caso explícitamente prohibido) es rechazada", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 1, monthsOfHistory: 24, hasAntitrustOpinion: true }),
    ).toThrow(/10 hoteles competidores/);
  });

  it("k=10 exacto con menos de 12 meses de histórico es rechazada", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 10, monthsOfHistory: 6, hasAntitrustOpinion: true }),
    ).toThrow(/12 meses de histórico/);
  });

  it("k=10, ≥12 meses, pero sin opinión antimonopolio documentada es rechazada", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 10, monthsOfHistory: 12, hasAntitrustOpinion: false }),
    ).toThrow(/opinión antimonopolio/);
  });

  it("k=10, 12 meses de histórico y opinión antimonopolio documentada: única combinación permitida", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 10, monthsOfHistory: 12, hasAntitrustOpinion: true }),
    ).not.toThrow();
  });
});
