// REQ-AB-011 (P1/GOB, fuente H10-016 en docs/referencia/02-investigacion-H01-H11.md):
// "El sistema debe mantener bitácoras digitales automatizadas de temperatura,
// recepción y limpieza conforme a NOM-251, disponibles para auditoría COFEPRIS."
//
// NOM-251-SSA1-2009 exige tres bitácoras físicas/digitales distintas en un
// establecimiento de A&B: (1) temperatura de equipos de frío/calor, (2) recepción de
// mercancía perecedera, (3) limpieza/desinfección de áreas. Este módulo modela las
// tres como un solo tipo discriminado (`BitacoraNom251Entrada`) porque comparten el
// mismo ciclo de vida de cumplimiento (registro inalterable, exportable a un
// inspector) aunque su forma de datos sea distinta -- exactamente el mismo criterio
// que separa `payload` por tipo en `fnb_order.items` o `consent_kind`.
//
// Honestidad de fuente (ADR-007/docs/ACEPTACION.md principio 2): ninguna fuente leída
// por este repo (docs/referencia/02-investigacion-H01-H11.md, H10 p.9-10) transcribe
// el texto íntegro de NOM-251-SSA1-2009 con sus rangos numéricos exactos -- solo
// confirma que "bitácoras de temperatura, recepción, limpieza... es automatizable con
// checklists y sensores". Los rangos de `RANGO_TEMPERATURA_SEGURO` de abajo son la
// práctica estándar de control sanitario de alimentos (refrigeración 0-4°C,
// congelación ≤-18°C, mantenimiento en caliente ≥60°C -- Codex Alimentarius/NOM-251
// difundida) usada aquí para poder EVALUAR una lectura automáticamente; si el fundador
// tiene el texto oficial con un rango distinto, este es el único lugar que hay que
// tocar. La entrada en sí SIEMPRE se guarda con el valor real capturado, nunca se
// descarta ni se fuerza a coincidir con el rango -- el rango solo alimenta la bandera
// `dentroDeRango`/`anomalia` que ayuda a quien audita, no bloquea el registro.
import { z } from "zod";

export const BITACORA_NOM251_TIPOS = ["temperatura", "recepcion", "limpieza"] as const;
export type BitacoraNom251Tipo = (typeof BITACORA_NOM251_TIPOS)[number];

export const temperaturaEquipoSchema = z.enum(["refrigeracion", "congelacion", "caliente"]);
export type TemperaturaEquipo = z.infer<typeof temperaturaEquipoSchema>;

export interface RangoTemperatura {
  minC: number | null;
  maxC: number | null;
}

export const RANGO_TEMPERATURA_SEGURO: Record<TemperaturaEquipo, RangoTemperatura> = {
  refrigeracion: { minC: 0, maxC: 4 },
  congelacion: { minC: null, maxC: -18 },
  caliente: { minC: 60, maxC: null },
};

export interface TemperaturaLecturaResultado {
  dentroDeRango: boolean;
  rangoEsperado: RangoTemperatura;
}

/** Evalúa una lectura de temperatura contra el rango seguro del tipo de equipo --
 *  puro, sin I/O. `congelacion` exige <= al máximo (más frío es siempre seguro);
 *  `caliente` exige >= al mínimo; `refrigeracion` exige estar dentro de [min, max]. */
export function evaluarLecturaTemperatura(equipo: TemperaturaEquipo, temperaturaC: number): TemperaturaLecturaResultado {
  const rango = RANGO_TEMPERATURA_SEGURO[equipo];
  const dentroDeRango = (rango.minC === null || temperaturaC >= rango.minC) && (rango.maxC === null || temperaturaC <= rango.maxC);
  return { dentroDeRango, rangoEsperado: rango };
}

export const temperaturaPayloadSchema = z.object({
  /** Identificador legible del equipo/área monitoreada, ej. "Refrigerador cocina 1",
   *  "Congelador barra", "Cuarto frío" -- texto libre porque el inventario de equipos
   *  varía por hotel y no existe todavía un catálogo de equipos F&B en el sistema. */
  equipo: z.string().trim().min(1).max(120),
  tipoEquipo: temperaturaEquipoSchema,
  temperaturaC: z.number().min(-40).max(100),
});
export type TemperaturaPayload = z.infer<typeof temperaturaPayloadSchema>;

export const recepcionPayloadSchema = z
  .object({
    proveedor: z.string().trim().min(1).max(200),
    producto: z.string().trim().min(1).max(200),
    lote: z.string().trim().max(100).optional(),
    /** Temperatura del producto a la recepción -- opcional porque no todo lo que se
     *  recibe es perecedero (ej. abarrotes secos no llevan lectura de temperatura). */
    temperaturaC: z.number().min(-40).max(100).optional(),
    empaqueIntegro: z.boolean(),
    fechaCaducidad: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "fechaCaducidad debe ser YYYY-MM-DD")
      .optional(),
    aceptado: z.boolean(),
    motivoRechazo: z.string().trim().min(1).max(500).optional(),
  })
  // Mismo patrón de invariante que `allergy_declared = (allergy_declared_via is not
  // null)` en fnb_order/0084: el motivo de rechazo existe SI Y SOLO SI se rechazó --
  // nunca un rechazo sin motivo auditable, nunca un motivo colgado de una recepción
  // aceptada.
  .refine((v) => v.aceptado === (v.motivoRechazo === undefined), {
    message: "motivoRechazo es obligatorio cuando aceptado=false, y no debe enviarse cuando aceptado=true",
    path: ["motivoRechazo"],
  });
export type RecepcionPayload = z.infer<typeof recepcionPayloadSchema>;

export const limpiezaTipoSchema = z.enum(["limpieza", "desinfeccion", "limpieza_y_desinfeccion"]);
export type LimpiezaTipo = z.infer<typeof limpiezaTipoSchema>;

export const limpiezaPayloadSchema = z.object({
  area: z.string().trim().min(1).max(200),
  tipoLimpieza: limpiezaTipoSchema,
  productoUsado: z.string().trim().min(1).max(200),
  /** Concentración del desinfectante en ppm -- opcional (una limpieza sin
   *  desinfectante, ej. barrido/trapeado con agua, no la lleva). */
  concentracionPpm: z.number().nonnegative().max(100_000).optional(),
});
export type LimpiezaPayload = z.infer<typeof limpiezaPayloadSchema>;

export const bitacoraNom251EntradaSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("temperatura"), payload: temperaturaPayloadSchema }),
  z.object({ tipo: z.literal("recepcion"), payload: recepcionPayloadSchema }),
  z.object({ tipo: z.literal("limpieza"), payload: limpiezaPayloadSchema }),
]);
export type BitacoraNom251Entrada = z.infer<typeof bitacoraNom251EntradaSchema>;

export interface BitacoraNom251Anomalia {
  anomalia: boolean;
  motivo: string | null;
}

/** Deriva si una entrada merece atención de quien audita -- puro, no bloquea el
 *  registro (la bitácora SIEMPRE guarda el valor real, incluida una lectura fuera de
 *  rango o un rechazo: ocultar el dato sería justo lo que NOM-251/COFEPRIS busca
 *  detectar). `limpieza` no tiene regla automática de anomalía: no hay una lectura
 *  numérica objetiva que evaluar, a diferencia de temperatura/recepción. */
export function detectarAnomaliaBitacora(entrada: BitacoraNom251Entrada): BitacoraNom251Anomalia {
  if (entrada.tipo === "temperatura") {
    const { dentroDeRango } = evaluarLecturaTemperatura(entrada.payload.tipoEquipo, entrada.payload.temperaturaC);
    return dentroDeRango
      ? { anomalia: false, motivo: null }
      : { anomalia: true, motivo: `Temperatura fuera del rango seguro para ${entrada.payload.tipoEquipo}` };
  }
  if (entrada.tipo === "recepcion") {
    return entrada.payload.aceptado
      ? { anomalia: false, motivo: null }
      : { anomalia: true, motivo: entrada.payload.motivoRechazo ?? "Mercancía rechazada" };
  }
  return { anomalia: false, motivo: null };
}

export interface BitacoraNom251Registro {
  id: string;
  registradoPor: string;
  registradoEn: string;
}

export type BitacoraNom251EntradaConMeta = BitacoraNom251Entrada & BitacoraNom251Registro;

/** Encabezados exactos que la exportación de cada bitácora debe llevar -- el criterio
 *  de aceptación de REQ-AB-011 ("exportación con campos exigidos por la norma") se
 *  verifica contra esta constante, no contra una descripción suelta. */
export const BITACORA_NOM251_CSV_HEADERS: Record<BitacoraNom251Tipo, readonly string[]> = {
  temperatura: ["fecha_hora", "equipo", "tipo_equipo", "temperatura_c", "rango_min_c", "rango_max_c", "dentro_de_rango", "registrado_por"],
  recepcion: [
    "fecha_hora",
    "proveedor",
    "producto",
    "lote",
    "temperatura_c",
    "empaque_integro",
    "fecha_caducidad",
    "aceptado",
    "motivo_rechazo",
    "registrado_por",
  ],
  limpieza: ["fecha_hora", "area", "tipo_limpieza", "producto_usado", "concentracion_ppm", "registrado_por"],
} as const;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function numOrEmpty(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function boolEsp(value: boolean): string {
  return value ? "si" : "no";
}

function filaCsv(entrada: BitacoraNom251EntradaConMeta): string[] {
  switch (entrada.tipo) {
    case "temperatura": {
      const { dentroDeRango, rangoEsperado } = evaluarLecturaTemperatura(entrada.payload.tipoEquipo, entrada.payload.temperaturaC);
      return [
        entrada.registradoEn,
        entrada.payload.equipo,
        entrada.payload.tipoEquipo,
        String(entrada.payload.temperaturaC),
        rangoEsperado.minC === null ? "" : String(rangoEsperado.minC),
        rangoEsperado.maxC === null ? "" : String(rangoEsperado.maxC),
        boolEsp(dentroDeRango),
        entrada.registradoPor,
      ];
    }
    case "recepcion":
      return [
        entrada.registradoEn,
        entrada.payload.proveedor,
        entrada.payload.producto,
        entrada.payload.lote ?? "",
        numOrEmpty(entrada.payload.temperaturaC),
        boolEsp(entrada.payload.empaqueIntegro),
        entrada.payload.fechaCaducidad ?? "",
        boolEsp(entrada.payload.aceptado),
        entrada.payload.motivoRechazo ?? "",
        entrada.registradoPor,
      ];
    case "limpieza":
      return [
        entrada.registradoEn,
        entrada.payload.area,
        entrada.payload.tipoLimpieza,
        entrada.payload.productoUsado,
        numOrEmpty(entrada.payload.concentracionPpm),
        entrada.registradoPor,
      ];
  }
}

/** Genera el CSV (CRLF, RFC 4180, mismo criterio que `buildStpsAttendanceCsv` de
 *  attendance.ts) de UN tipo de bitácora, listo para entregar a una auditoría
 *  COFEPRIS. Filas cuyo `tipo` no coincida con `tipo` se ignoran defensivamente --
 *  quien llama (la ruta) debe filtrar por tipo antes, esto es una segunda barrera. */
export function buildBitacoraNom251Csv(tipo: BitacoraNom251Tipo, entradas: BitacoraNom251EntradaConMeta[]): string {
  const headers = BITACORA_NOM251_CSV_HEADERS[tipo];
  const lines = [headers.join(",")];
  for (const entrada of entradas) {
    if (entrada.tipo !== tipo) continue;
    lines.push(filaCsv(entrada).map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
