// REQ-RES-012 (P1/F, fuentes BP-089/H01-008/H02-013/H02-015/H05-011): motor de
// cotización de GRUPO/evento (bodas, retiros, room blocks), contraparte del motor de
// cotización individual (`../quote.ts`). Dos diferencias de negocio reales frente a una
// cotización individual:
//
//  1. SLA de tiempo (H02-013/H05-011: "en menos de 15 minutos desde la solicitud"): el
//     input exige `requestedAt`/`quotedAt` explícitos -- nunca se infiere de `Date.now()`
//     dentro de este módulo puro (mismo criterio que el resto de domain-hotel: sin I/O,
//     sin reloj propio) para poder probarlo de forma determinista.
//  2. Consulta obligatoria al motor de Revenue ANTES de fijar el precio (H02-015: "el
//     costo de desplazamiento -- noches que se dejarían de vender x ADR esperado --
//     antes de fijar el precio de un grupo"). Esa consulta se modela en el TIPO del
//     input: `nightlyDisplacement` es un array OBLIGATORIO (min 1) de
//     `{ date, roomsDisplaced, expectedAdr }` con una fila por cada noche de la
//     estadía -- ninguna ruta de este repositorio puede invocar `computeGroupQuote` sin
//     haber consultado antes cuántas habitaciones desplazaría el bloque y a qué ADR
//     esperado (ver `apps/api/src/domain/groupQuote.ts::estimateNightlyDisplacement`,
//     que puebla este array con datos reales de `rate_plan`/`availability`, jamás
//     inventados). El resultado (`groupPrice`) internaliza ese costo de oportunidad:
//     `groupPrice = manualPrice + displacementCost`, así que `groupPrice` SOLO puede
//     coincidir con `manualPrice` cuando el desplazamiento estimado es exactamente cero
//     (ninguna noche del bloque está lo bastante ocupada para desplazar demanda
//     individual) -- exactamente el criterio verificado en
//     `tests/integration/grupos/cotizacion.spec.ts`.
import { z } from "zod";
import { roundCurrency } from "../money.ts";
import { nightsBetween } from "../quote.ts";

export class GroupQuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GroupQuoteError";
    this.code = code;
  }
}

/** H02-013/H05-011: "menos de 15 minutos desde la solicitud". Un solo umbral para todo
 *  el sistema -- si algún día se necesita un SLA distinto por hotel, se vuelve
 *  configuración explícita, nunca un número distinto adivinado ad-hoc en cada llamador. */
export const GROUP_QUOTE_SLA_MINUTES = 15;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");
const isoTimestampSchema = z.string().datetime({ offset: true, message: "se espera un timestamp ISO 8601 con offset (ej. 2026-01-01T10:00:00Z)" });

// Una fila REAL por noche del bloque -- ver comentario de archivo. `roomsDisplaced` es
// el número de habitaciones que el motor de Revenue estima que se habrían vendido a
// huéspedes individuales esa noche si no se reservan para el grupo (nunca puede exceder
// `roomsRequested`, se valida cruzado en `computeGroupQuote`). `expectedAdr` es el ADR
// esperado esa noche según la tarifa vigente del motor de Revenue (`rate_plan.price`).
const nightlyDisplacementSchema = z.object({
  date: dateSchema,
  roomsDisplaced: z.number().int().nonnegative(),
  expectedAdr: z.number().nonnegative(),
});

export const groupQuoteInputSchema = z
  .object({
    /** Momento en que llegó la solicitud de grupo (email/WhatsApp/formulario/llamada) -- capturado por quien la atendió, NUNCA inferido. */
    requestedAt: isoTimestampSchema,
    /** Momento en que esta cotización se genera/envía. */
    quotedAt: isoTimestampSchema,
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
    currency: z.string().default("MXN"),
    /** Habitaciones que el grupo solicita bloquear (mismas todas las noches de la estadía). */
    roomsRequested: z.number().int().positive(),
    /** Precio TOTAL propuesto manualmente por ventas ANTES del ajuste de desplazamiento
     *  (ej. tarifa de grupo negociada a mano) -- puede ser 0 si aún no se ha propuesto
     *  ningún precio y se quiere ver solo el piso de desplazamiento. */
    manualPrice: z.number().nonnegative(),
    nightlyDisplacement: z.array(nightlyDisplacementSchema).min(1),
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

export type GroupQuoteInput = z.infer<typeof groupQuoteInputSchema>;
export type NightlyDisplacement = z.infer<typeof nightlyDisplacementSchema>;

export interface GroupQuote {
  readonly nights: number;
  readonly currency: string;
  readonly roomsRequested: number;
  readonly manualPrice: number;
  /** Suma de `roomsDisplaced x expectedAdr` de todas las noches -- costo de oportunidad
   *  real de dar el bloque al grupo en vez de venderlo individualmente. */
  readonly displacementCost: number;
  /** `manualPrice + displacementCost`, redondeado. Precio final que se le propone al
   *  grupo -- nunca se "sugiere" desde otro lugar. */
  readonly groupPrice: number;
  readonly nightlyDisplacement: readonly NightlyDisplacement[];
  /** Minutos completos transcurridos entre `requestedAt` y `quotedAt`. */
  readonly slaMinutes: number;
  /** `slaMinutes <= GROUP_QUOTE_SLA_MINUTES` -- métrica de cumplimiento (H02-013), NO
   *  bloquea la generación de la cotización: una cotización tardía sigue siendo una
   *  cotización real, solo queda marcada como incumplimiento de SLA para que ventas/GM
   *  le dé seguimiento, en vez de desaparecer silenciosamente. */
  readonly withinSla: boolean;
}

export function parseGroupQuoteInput(raw: unknown): GroupQuoteInput {
  return groupQuoteInputSchema.parse(raw);
}

/** Minutos completos (piso) entre dos timestamps ISO -- nunca negativo hacia el
 *  llamador: una `quotedAt` anterior a `requestedAt` es un error de datos (alguien
 *  cotizó "antes" de recibir la solicitud), se rechaza en `computeGroupQuote`, no aquí. */
function minutesBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.floor(ms / (60 * 1000));
}

/**
 * Cotiza un room block de grupo de forma determinista: valida la consulta al motor de
 * Revenue (una fila de desplazamiento por cada noche de la estadía, ninguna
 * inventada/faltante) y calcula el precio final internalizando ese costo de
 * oportunidad. Nunca acepta un precio de grupo que no haya pasado por esta consulta
 * (REQ-RES-012/H02-015) -- ver comentario de archivo.
 */
export function computeGroupQuote(input: GroupQuoteInput): GroupQuote {
  if (input.checkOutDate <= input.checkInDate) {
    throw new GroupQuoteError("estadia_invalida", "checkOutDate debe ser posterior a checkInDate.");
  }
  const nights = nightsBetween(input.checkInDate, input.checkOutDate);
  if (nights.length < 1) {
    throw new GroupQuoteError("estadia_invalida", "La estadía del bloque debe ser de al menos 1 noche.");
  }

  const requestedMs = new Date(input.requestedAt).getTime();
  const quotedMs = new Date(input.quotedAt).getTime();
  if (Number.isNaN(requestedMs) || Number.isNaN(quotedMs)) {
    throw new GroupQuoteError("timestamp_invalido", "requestedAt/quotedAt deben ser timestamps ISO 8601 válidos.");
  }
  if (quotedMs < requestedMs) {
    throw new GroupQuoteError(
      "orden_de_tiempo_invalido",
      "quotedAt no puede ser anterior a requestedAt (no se puede cotizar antes de recibir la solicitud).",
    );
  }

  // La consulta al motor de Revenue debe cubrir EXACTAMENTE las noches de la estadía --
  // ni una noche de menos (precio fijado "a ciegas" para esa noche) ni filas de fechas
  // fuera de rango (que solo esconderían un bug del llamador).
  const displacementByDate = new Map(input.nightlyDisplacement.map((d) => [d.date, d]));
  if (displacementByDate.size !== input.nightlyDisplacement.length) {
    throw new GroupQuoteError("desplazamiento_duplicado", "nightlyDisplacement tiene más de una fila para la misma fecha.");
  }
  for (const date of nights) {
    if (!displacementByDate.has(date)) {
      throw new GroupQuoteError(
        "desplazamiento_incompleto",
        `Falta la consulta al motor de Revenue (desplazamiento de ADR) para la noche ${date}: no se puede fijar el precio de grupo sin ella (REQ-RES-012).`,
      );
    }
  }
  for (const [date, row] of displacementByDate) {
    if (!nights.includes(date)) {
      throw new GroupQuoteError("desplazamiento_fuera_de_rango", `nightlyDisplacement incluye la fecha ${date}, fuera de la estadía cotizada.`);
    }
    if (row.roomsDisplaced > input.roomsRequested) {
      throw new GroupQuoteError(
        "desplazamiento_excede_bloque",
        `roomsDisplaced (${row.roomsDisplaced}) de la noche ${date} no puede exceder roomsRequested (${input.roomsRequested}).`,
      );
    }
  }

  let displacementCost = 0;
  for (const date of nights) {
    const row = displacementByDate.get(date)!;
    displacementCost = roundCurrency(displacementCost + row.roomsDisplaced * row.expectedAdr);
  }

  const groupPrice = roundCurrency(input.manualPrice + displacementCost);
  const slaMinutes = minutesBetween(input.requestedAt, input.quotedAt);

  return {
    nights: nights.length,
    currency: input.currency,
    roomsRequested: input.roomsRequested,
    manualPrice: roundCurrency(input.manualPrice),
    displacementCost,
    groupPrice,
    nightlyDisplacement: nights.map((date) => displacementByDate.get(date)!),
    slaMinutes,
    withinSla: slaMinutes <= GROUP_QUOTE_SLA_MINUTES,
  };
}
