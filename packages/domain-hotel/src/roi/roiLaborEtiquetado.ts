// REQ-HK-022 (P1/GOB, BP-076): "El ahorro de labor de housekeeping/mantenimiento
// reportado como ROI solo debe considerarse verificado si la plantilla se
// variabilizó (eventuales, descansos móviles); de lo contrario el reporte debe
// etiquetarlo explícitamente como no verificado." BLUEPRINT-HOTELES p.21 (BP-076):
// "El ahorro de labor de housekeeping solo se materializa si la plantilla se
// variabiliza (eventuales, descansos móviles); condición explícita del ROI."
//
// Por qué el gate es "¿se variabilizó la plantilla?" y no "¿hubo un número positivo?":
// un ahorro de labor de housekeeping/mantenimiento SOLO es dinero real (no una ilusión
// contable) si las horas/turnos efectivamente PAGADOS bajaron -- y eso únicamente ocurre
// si la plantilla dejó de ser fija y empezó a ajustarse a la demanda real vía personal
// eventual y/o descansos reprogramados en día variable. Si la plantilla sigue fija
// (mismo personal, mismos descansos, mismas horas programadas pase lo que pase la
// ocupación) cualquier "ahorro" que el motor de ROI calcule es una PROYECCIÓN
// optimista sin respaldo operativo -- de ahí que el reporte deba decirlo
// EXPLÍCITAMENTE, en el texto que ve el dueño, nunca solo en un booleano interno que la
// UI podría no renderizar (mismo principio de honestidad que ya aplica
// `pl/reporteMensualDueno.ts` para REQ-OBS-007/BP-171, y verificado por ACEPTACION.md
// "revisando el TEXTO del reporte generado en ambos escenarios").
//
// Nota deliberada sobre el umbral: se exige evidencia de AL MENOS UNO de los dos
// mecanismos que cita BP-076 ("eventuales, descansos móviles"), no de los dos a la vez
// -- el texto del requisito los enumera como ejemplos de qué significa "variabilizar"
// la plantilla, no como una lista de condiciones conjuntas; exigir ambos inventaría una
// condición que ni REQ-HK-022 ni BP-076 piden. Cualquier conteo > 0 debe venir de
// evidencia YA REGISTRADA (la plantilla de turnos publicada -- ver
// `housekeeping/turnos-lft.ts` -- o el sistema de nómina/RR.HH.), nunca inferido aquí:
// este módulo es PURO (sin I/O), mismo criterio que el resto de `domain-hotel`.

/** Evidencia YA REGISTRADA de que la plantilla de housekeeping/mantenimiento se ajustó
 *  a la demanda real en el periodo del reporte, en vez de mantenerse fija. Ambos
 *  campos son conteos de eventos ya capturados (plantilla de turnos publicada y/o
 *  nómina/RR.HH.) -- nunca estimaciones. */
export interface PlantillaVariabilizacionEvidence {
  /** Altas de personal de housekeeping/mantenimiento bajo modalidad eventual (no
   *  planta fija) registradas dentro del periodo. */
  readonly eventualesRegistrados: number;
  /** Descansos semanales (Art. 69 LFT) programados en día variable -- no siempre el
   *  mismo día de la semana para la misma persona -- dentro del periodo, tal como
   *  quedaron en la plantilla de turnos publicada. */
  readonly descansosMovilesRegistrados: number;
}

export interface AhorroLaborHousekeepingInput {
  readonly hotelId: string;
  readonly periodo: { readonly desde: string; readonly hasta: string };
  /** Ahorro de labor housekeeping/mantenimiento que calculó el motor de ROI para el
   *  periodo, en USD (mismo criterio de moneda que `roi/roiBaseline.ts` y
   *  `pl/reporteMensualDueno.ts`, que alimentan el mismo `roi_event`/reporte al dueño).
   *  Debe ser un número finito >= 0 -- "$0 de ahorro" también se reporta, nunca se
   *  omite la fila. */
  readonly ahorroReportadoUsd: number;
  readonly evidenciaVariabilizacion: PlantillaVariabilizacionEvidence;
}

export interface AhorroLaborHousekeepingReport {
  readonly hotelId: string;
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly ahorroReportadoUsd: number;
  /** `true` únicamente cuando hay evidencia registrada de que la plantilla se
   *  variabilizó (al menos un eventual O un descanso móvil registrados en el periodo).
   *  `false` en cualquier otro caso, incluyendo evidencia en cero. */
  readonly verificado: boolean;
  readonly evidenciaVariabilizacion: PlantillaVariabilizacionEvidence;
  /** Texto literal para el reporte que ve el dueño. Contiene la palabra "verificado"
   *  cuando `verificado` es `true`, o la frase explícita "no verificado" cuando es
   *  `false` -- REQ-HK-022: "el reporte debe etiquetarlo explícitamente como no
   *  verificado". NUNCA se omite, suaviza ni queda implícito solo en el booleano. */
  readonly etiquetaTexto: string;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)} USD`;
}

function assertValidEvidence(evidencia: PlantillaVariabilizacionEvidence): void {
  if (!Number.isFinite(evidencia.eventualesRegistrados) || evidencia.eventualesRegistrados < 0) {
    throw new RangeError(
      `evidencia_invalida: eventualesRegistrados debe ser un número finito >= 0, recibido ${evidencia.eventualesRegistrados}`,
    );
  }
  if (!Number.isFinite(evidencia.descansosMovilesRegistrados) || evidencia.descansosMovilesRegistrados < 0) {
    throw new RangeError(
      `evidencia_invalida: descansosMovilesRegistrados debe ser un número finito >= 0, recibido ${evidencia.descansosMovilesRegistrados}`,
    );
  }
}

/**
 * ¿La evidencia registrada basta para considerar que la plantilla de
 * housekeeping/mantenimiento se variabilizó en el periodo (BP-076)? `true` si hay al
 * menos un eventual O al menos un descanso móvil registrados -- ver nota de cabecera
 * sobre por qué no se exigen los dos mecanismos a la vez.
 */
export function evaluarVariabilizacionPlantilla(evidencia: PlantillaVariabilizacionEvidence): boolean {
  assertValidEvidence(evidencia);
  return evidencia.eventualesRegistrados > 0 || evidencia.descansosMovilesRegistrados > 0;
}

/**
 * Corazón de REQ-HK-022: etiqueta el ahorro de labor de housekeeping/mantenimiento
 * reportado como ROI, en función de si hay evidencia registrada de que la plantilla se
 * variabilizó. Determinista y sin efectos secundarios (misma entrada -> misma salida,
 * mismo criterio de auditabilidad que `pl/reporteMensualDueno.ts`). Nunca lanza por la
 * regla de negocio en sí -- solo por datos estructuralmente inválidos (montos/conteos
 * negativos o no finitos).
 */
export function buildReporteAhorroLaborHousekeeping(
  input: AhorroLaborHousekeepingInput,
): AhorroLaborHousekeepingReport {
  if (!Number.isFinite(input.ahorroReportadoUsd) || input.ahorroReportadoUsd < 0) {
    throw new RangeError(
      `ahorro_invalido: ahorroReportadoUsd debe ser un número finito >= 0, recibido ${input.ahorroReportadoUsd}`,
    );
  }
  assertValidEvidence(input.evidenciaVariabilizacion);

  const verificado = evaluarVariabilizacionPlantilla(input.evidenciaVariabilizacion);
  const { eventualesRegistrados, descansosMovilesRegistrados } = input.evidenciaVariabilizacion;

  const etiquetaTexto = verificado
    ? `Ahorro de labor housekeeping/mantenimiento VERIFICADO este periodo (${input.periodo.desde} a ${input.periodo.hasta}): ${formatUsd(input.ahorroReportadoUsd)}. La plantilla se variabilizó (${eventualesRegistrados} eventual(es), ${descansosMovilesRegistrados} descanso(s) móvil(es) registrados), por lo que el ahorro reportado tiene respaldo operativo real (REQ-HK-022/BP-076).`
    : `Ahorro de labor housekeeping/mantenimiento reportado, NO VERIFICADO este periodo (${input.periodo.desde} a ${input.periodo.hasta}): ${formatUsd(input.ahorroReportadoUsd)}. La plantilla NO se variabilizó (${eventualesRegistrados} eventual(es), ${descansosMovilesRegistrados} descanso(s) móvil(es) registrados) -- este ahorro es una proyección sin respaldo operativo confirmado y no debe contarse como dinero recuperado real hasta que exista evidencia de variabilización (REQ-HK-022/BP-076).`;

  return {
    hotelId: input.hotelId,
    periodo: input.periodo,
    ahorroReportadoUsd: input.ahorroReportadoUsd,
    verificado,
    evidenciaVariabilizacion: input.evidenciaVariabilizacion,
    etiquetaTexto,
  };
}
