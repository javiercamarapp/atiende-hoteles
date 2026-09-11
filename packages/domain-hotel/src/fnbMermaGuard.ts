/**
 * REQ-AB-010 (P2/F): "El sistema debe registrar merma de inventario F&B por causa
 * (clima, robo, caducidad, etc.) en todos los centros de consumo." El criterio de
 * aceptación literal de `docs/ACEPTACION.md` exige "un registro por causa" verificado,
 * y la fuente de investigación (H10-015) lo deja todavía más estricto: "El 100% de los
 * ajustes de merma quedan clasificados por causa en el registro de inventario" -- por
 * eso la causa NUNCA es texto libre sin clasificar: es un enum cerrado a nivel de
 * aplicación (aquí) Y de base de datos (CHECK estructural en la migración
 * 0130_fnb_merma.sql), mismo patrón de defensa en dos capas que
 * `fnbAllergyGuard.ts`/0084_fnb_order.sql.
 *
 * Módulo de dominio PURO: ninguna función de aquí toca I/O -- `apps/api/src/routes/
 * fnbMerma.ts` es quien persiste el registro y decide cuándo invocar la guarda antes
 * de aceptarlo.
 */

// Mismo set canónico de centros de consumo que H10-011 ("múltiples centros de consumo:
// restaurante, pool bar, room service, desayuno, minibar, eventos") -- REQ-AB-010 pide
// cubrir "todos los centros de consumo", así que la causa se clasifica contra la MISMA
// lista que usará REQ-AB-007 (traspasos internos) cuando se construya, en vez de que
// cada requisito invente su propio vocabulario de ubicaciones.
export const FNB_CENTROS_CONSUMO = ["restaurante", "pool_bar", "room_service", "desayuno", "minibar", "eventos"] as const;

export type FnbCentroConsumo = (typeof FNB_CENTROS_CONSUMO)[number];

export function isFnbCentroConsumo(value: string): value is FnbCentroConsumo {
  return (FNB_CENTROS_CONSUMO as readonly string[]).includes(value);
}

// H10-015 literal: "clima, huracán, robo, caducidad" (+ "etc." de REQ-AB-010). Se
// mantiene "clima" y "huracan" como causas DISTINTAS aunque ambas sean climáticas: un
// huracán (apagón prolongado, refrigeración perdida por horas/días) tiene una causa
// raíz y una escala de pérdida muy distinta a un clima adverso ordinario (p.ej. una
// lluvia que afecta un evento al aire libre) -- fusionarlas perdería la señal que un
// hotel de Riviera Maya necesita para su reporte de merma por temporada de huracanes.
// "otro" cubre el "etc." del requisito, pero SIEMPRE exige una nota (ver
// `assertValidFnbMerma`) -- una causa "otro" sin explicación no es una clasificación
// útil para la auditoría que exige H10-015.
export const FNB_MERMA_CAUSAS = ["clima", "huracan", "robo", "caducidad", "otro"] as const;

export type FnbMermaCausa = (typeof FNB_MERMA_CAUSAS)[number];

export function isFnbMermaCausa(value: string): value is FnbMermaCausa {
  return (FNB_MERMA_CAUSAS as readonly string[]).includes(value);
}

export interface FnbMermaInput {
  readonly centroConsumo: string;
  readonly causa: string;
  /** Cantidad mermada, en la unidad que declare el registro (kg, pza, lt, etc.) --
   *  la unidad misma no es una regla de negocio (la valida el esquema de la ruta), solo
   *  que la cantidad sea un número positivo real. */
  readonly cantidad: number;
  readonly nota: string | null | undefined;
}

export class FnbMermaInvalidError extends Error {
  code = "fnb_merma_invalida";
  constructor(message: string) {
    super(message);
    this.name = "FnbMermaInvalidError";
  }
}

/** Valida un registro de merma ANTES de persistirlo -- fail-closed: cualquier causa o
 *  centro de consumo fuera del enum cerrado, cantidad no positiva, o causa "otro" sin
 *  nota explicando la causa real, truena. Si no truena, el registro es seguro de
 *  insertar. Toda ruta que vaya a registrar una merma DEBE llamar esto primero (mismo
 *  principio que `assertCanAssureDishIsSafe`). */
export function assertValidFnbMerma(input: FnbMermaInput): void {
  if (!isFnbCentroConsumo(input.centroConsumo)) {
    throw new FnbMermaInvalidError(
      `Centro de consumo no reconocido: "${input.centroConsumo}". Debe ser uno de: ${FNB_CENTROS_CONSUMO.join(", ")}.`,
    );
  }
  if (!isFnbMermaCausa(input.causa)) {
    throw new FnbMermaInvalidError(`Causa de merma no reconocida: "${input.causa}". Debe ser una de: ${FNB_MERMA_CAUSAS.join(", ")}.`);
  }
  if (!Number.isFinite(input.cantidad) || input.cantidad <= 0) {
    throw new FnbMermaInvalidError("La cantidad de merma debe ser un número mayor a cero.");
  }
  if (input.causa === "otro" && (input.nota == null || input.nota.trim().length === 0)) {
    throw new FnbMermaInvalidError(
      'La causa "otro" requiere una nota explicando la causa real -- sin ella, el registro de merma no queda clasificado de forma útil para auditoría (REQ-AB-010/H10-015).',
    );
  }
}

export interface FnbMermaCausaResumen {
  readonly causa: FnbMermaCausa;
  readonly registros: number;
  readonly cantidadTotal: number;
}

/** Agrupa una lista de mermas ya persistidas por causa -- función de dominio pura de
 *  reporte (sin I/O), usada por la ruta de reporte para responder "el 100% de los
 *  ajustes de merma quedan clasificados por causa" con una cifra verificable en vez de
 *  que cada consumidor de la API reimplemente el `group by`. */
export function summarizeFnbMermaByCausa(
  registros: ReadonlyArray<{ causa: string; cantidad: number }>,
): FnbMermaCausaResumen[] {
  const porCausa = new Map<FnbMermaCausa, { registros: number; cantidadTotal: number }>();
  for (const registro of registros) {
    if (!isFnbMermaCausa(registro.causa)) continue; // defensivo: la BD ya lo garantiza vía CHECK
    const actual = porCausa.get(registro.causa) ?? { registros: 0, cantidadTotal: 0 };
    porCausa.set(registro.causa, {
      registros: actual.registros + 1,
      cantidadTotal: actual.cantidadTotal + registro.cantidad,
    });
  }
  return FNB_MERMA_CAUSAS.filter((causa) => porCausa.has(causa)).map((causa) => ({
    causa,
    ...porCausa.get(causa)!,
  }));
}
