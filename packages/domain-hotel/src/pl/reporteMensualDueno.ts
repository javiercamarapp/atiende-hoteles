// REQ-OBS-007 (P0/BP-171/H17-001): "El reporte mensual al dueño debe distinguir
// explícitamente 'recuperado/verificado' de 'estimado' (separado); si lo verificado
// es menor que la cuota, el reporte lo debe decir explícitamente (regla de
// honestidad)."
//
// Motor PURO (sin acceso a DB, determinista, mismo principio que
// `packages/domain-hotel/src/pl/usaliPL.ts` y `revenue/walkForwardBacktest.ts`): agrega
// los `ROIEvent` YA CAPTURADOS por H7 (`monto_verificado`/`monto_estimado`,
// REQ-AGT-003/REQ-REV-018, ver `apps/api/src/routes/roi.ts`) en un reporte mensual con
// dos totales SIEMPRE separados -- nunca sumados en una sola cifra que oculte cuánto de
// ese total es dinero verificado de verdad, mismo criterio que ya aplica
// `apps/api/src/routes/roi.ts` (`sumaEstimadoUsd`/`sumaVerificadoUsd` nunca fusionados) y
// `apps/api/src/routes/backOffice.ts` (solo se factura `monto_verificado`, nunca el
// estimado) -- y una declaración de honestidad explícita en TEXTO LITERAL (no solo un
// booleano interno que la UI podría no mostrar) cuando lo verificado no alcanza a cubrir
// la cuota de cobro del periodo.
//
// La agregación desde Postgres de los `roi_event` reales del mes (y de la cuota de
// cobro real facturada, cuando exista esa lógica de facturación -- REQ-REV-018 la deja
// pendiente) vive en la capa API/consumidor, igual que `usaliPL.ts` deja la agregación
// SQL en `apps/api/src/domain/plUsali.ts`: este módulo solo aplica la aritmética y la
// regla de honestidad sobre eventos YA agregados, para que sea unit-testeable sin
// levantar Postgres (ver `tests/unit/domain-hotel/reporte-mensual-honestidad.spec.ts`).

/** Un evento de ROI ya agregado del periodo (mismo shape que expone `GET /roi`,
 *  ver `apps/api/src/routes/roi.ts`). */
export interface RoiEventoMensual {
  readonly agente: string;
  readonly tipoEvento: string;
  /** Monto proyectado/estimado del evento (método contrafactual declarado, sin
   *  verificar todavía). `null` cuando el evento no trae estimado. */
  readonly montoEstimadoUsd: number | null;
  /** Monto CONFIRMADO/recuperado del evento -- el único que cuenta como "recuperado" en
   *  este reporte. `null` mientras el evento siga sin verificar. */
  readonly montoVerificadoUsd: number | null;
}

export interface ReporteMensualDuenoInput {
  readonly hotelId: string;
  readonly periodo: { readonly desde: string; readonly hasta: string };
  /** Todos los `RoiEventoMensual` del hotel en el periodo -- vacío es válido (hotel sin
   *  eventos todavía) y se reporta como tal, nunca se fabrica un evento. */
  readonly eventos: readonly RoiEventoMensual[];
  /** Lo que se le factura al dueño este periodo por el servicio (suscripción y/o
   *  cualquier cobro por resultado ya facturado) -- SIEMPRE un monto real de
   *  facturación aportado por el llamador, nunca inferido ni estimado aquí (BP-171:
   *  "si lo verificado es menor que LA CUOTA"). Debe ser >= 0. */
  readonly cuotaCobroUsd: number;
}

export interface ReporteMensualDueno {
  readonly hotelId: string;
  readonly periodo: { readonly desde: string; readonly hasta: string };
  /** Suma de `montoVerificadoUsd` de TODOS los eventos -- solo dinero recuperado
   *  confirmado, nunca proyectado. Esta es la única cifra que este reporte reconoce
   *  como "recuperado". */
  readonly totalRecuperadoVerificadoUsd: number;
  /** Suma de `montoEstimadoUsd` SOLO de eventos que todavía NO tienen verificado (si un
   *  evento ya se verificó, su monto ya se contó en `totalRecuperadoVerificadoUsd` y no
   *  se duplica aquí como estimado -- mismo criterio que la columna `estimado` de
   *  `roi_event`, ver `apps/api/src/routes/roi.ts`). Reportado SEPARADO, nunca sumado al
   *  verificado. */
  readonly totalEstimadoUsd: number;
  readonly cuotaCobroUsd: number;
  /** `totalRecuperadoVerificadoUsd - cuotaCobroUsd`. Negativo = lo verificado NO cubre
   *  la cuota de cobro del periodo. */
  readonly brechaVerificadoVsCuotaUsd: number;
  /** `false` cuando `totalRecuperadoVerificadoUsd < cuotaCobroUsd` -- la señal que
   *  dispara la regla de honestidad de BP-171. Nunca se calcula sobre el estimado. */
  readonly verificadoCubreCuota: boolean;
  /** `true` cuando el hotel no tuvo ningún evento de ROI en el periodo (no se fabrica un
   *  "$0.00" ambiguo entre "sin datos" y "datos en cero", mismo criterio de REQ-UX-002 ya
   *  aplicado en `apps/api/src/routes/roi.ts`: `sinDatos`). */
  readonly eventosSinDatos: boolean;
  /** Texto literal para el reporte del dueño. NUNCA se omite, suaviza ni oculta cuando
   *  `verificadoCubreCuota` es `false` -- esa es la regla de honestidad completa (BP-171:
   *  "el reporte lo debe decir explícitamente"), no solo un campo booleano que la UI
   *  podría no renderizar. */
  readonly declaracionHonestidad: string;
}

function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)} USD`;
}

/**
 * Ensambla el reporte mensual de ROI para el dueño exigido por REQ-OBS-007/BP-171:
 * "recuperado/verificado" y "estimado" SIEMPRE separados, con una declaración de
 * honestidad en texto cuando lo verificado no alcanza la cuota de cobro. Determinista y
 * sin efectos secundarios -- la misma entrada siempre produce la misma salida (mismo
 * criterio de auditabilidad que `revenue/walkForwardBacktest.ts`).
 */
export function buildReporteMensualDueno(input: ReporteMensualDuenoInput): ReporteMensualDueno {
  if (!Number.isFinite(input.cuotaCobroUsd) || input.cuotaCobroUsd < 0) {
    throw new RangeError(`cuota_invalida: cuotaCobroUsd debe ser un número finito >= 0, recibido ${input.cuotaCobroUsd}`);
  }

  const totalRecuperadoVerificadoUsd = sumBy(input.eventos, (e) => e.montoVerificadoUsd ?? 0);
  const totalEstimadoUsd = sumBy(
    input.eventos.filter((e) => e.montoVerificadoUsd == null),
    (e) => e.montoEstimadoUsd ?? 0,
  );
  const eventosSinDatos = input.eventos.length === 0;

  const brechaVerificadoVsCuotaUsd = totalRecuperadoVerificadoUsd - input.cuotaCobroUsd;
  const verificadoCubreCuota = brechaVerificadoVsCuotaUsd >= 0;

  const declaracionHonestidad = verificadoCubreCuota
    ? `Recuperado/verificado este periodo: ${formatUsd(totalRecuperadoVerificadoUsd)}. Cubre la cuota de cobro del periodo (${formatUsd(input.cuotaCobroUsd)}).`
    : `Aviso de honestidad: lo recuperado/verificado este periodo (${formatUsd(totalRecuperadoVerificadoUsd)}) es MENOR que la cuota de cobro del periodo (${formatUsd(input.cuotaCobroUsd)}) -- brecha sin cubrir con valor verificado: ${formatUsd(Math.abs(brechaVerificadoVsCuotaUsd))}.${
        totalEstimadoUsd > 0
          ? ` Hay ${formatUsd(totalEstimadoUsd)} adicionales en eventos ESTIMADOS (sin verificar) que NO se cuentan para cubrir esta cuota.`
          : ""
      }`;

  return {
    hotelId: input.hotelId,
    periodo: input.periodo,
    totalRecuperadoVerificadoUsd,
    totalEstimadoUsd,
    cuotaCobroUsd: input.cuotaCobroUsd,
    brechaVerificadoVsCuotaUsd,
    verificadoCubreCuota,
    eventosSinDatos,
    declaracionHonestidad,
  };
}
