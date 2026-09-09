// REQ-RES-020 (P1/F): "el sistema debe registrar, por reserva, el canal/agente de
// origen (directo, OTA, agente de IA externo) para atribución de comisión y reporting
// de room-nights directas". El REGISTRO ya existe (`reservation.channel`, migración
// 0014) -- este módulo es el CÁLCULO puro (sin I/O) del reporte de atribución sobre
// esos datos, contraparte determinista de `apps/api/src/domain/atribucionCanal.ts`
// (que agrega desde `public.reservation` + `public.hotel_channel_commission`, mismo
// principio de separación que `pl/usaliPL.ts`/`apps/api/src/domain/plUsali.ts`).
//
// Import HONESTO: hoy 'directo' es el ÚNICO valor que cualquier escritor de este repo
// produce (REQ-RES-022/REQ-REV-008, H15-006, prohíben conectividad OTA propia en esta
// fase) -- este módulo no inventa ni simula diversidad de canal; solo queda listo para
// cuando exista un channel manager certificado o el servidor MCP de REQ-RES-021
// empiece a escribir 'agente_ia_externo'. Las pruebas unitarias sí usan canales
// hipotéticos ('ota_ejemplo', etc.) para verificar el CÁLCULO -- mismo criterio que
// `revenue/parity-guard.ts` ya aplica para probar su propia lógica de canal.
import { roundCurrency } from "../money.ts";

/** Único valor que `reservation.channel` puede tomar hoy en producción -- nunca paga
 *  comisión, sin importar qué exista en `hotel_channel_commission`. */
export const DIRECT_CHANNEL = "directo";

export interface ChannelCommissionConfig {
  readonly channel: string;
  /** 0..100. */
  readonly commissionPct: number;
}

export interface ReservationAttributionInput {
  readonly id: string;
  readonly channel: string;
  /** Número de noches de la reserva (>= 1). */
  readonly nights: number;
  /** `reservation.total_amount`: NETO sin impuestos (mismo campo que factura la comisión, nunca el bruto con IVA/ISH). */
  readonly netAmount: number;
}

export interface ChannelAttributionSummary {
  readonly channel: string;
  readonly reservationCount: number;
  readonly roomNights: number;
  readonly netRevenue: number;
  readonly commissionPct: number;
  readonly commissionAmount: number;
  readonly netRevenueAfterCommission: number;
}

export interface ChannelAttributionReport {
  readonly channels: ChannelAttributionSummary[];
  readonly totalReservations: number;
  readonly totalRoomNights: number;
  readonly directRoomNights: number;
  /** 0..100. `0` (no `NaN`) cuando no hay reservas -- REQ-UX-002: el llamador decide
   *  si mostrar "sin datos" con `totalReservations === 0`, este módulo nunca devuelve
   *  un valor no numérico. */
  readonly directRoomNightsPct: number;
  readonly totalCommissionAmount: number;
}

export function isDirectChannel(channel: string): boolean {
  return channel === DIRECT_CHANNEL;
}

/** 'directo' es SIEMPRE 0% sin importar `configs` (fail-closed hacia "nunca le cobres
 *  comisión a una reserva directa por un error de captura en la tabla de config"). Un
 *  canal sin fila de configuración también resuelve a 0% -- fail-closed hacia "nunca
 *  inventes una comisión que nadie dio de alta explícitamente", nunca hacia cobrarla de
 *  más. */
export function resolveCommissionPct(channel: string, configs: readonly ChannelCommissionConfig[]): number {
  if (isDirectChannel(channel)) return 0;
  return configs.find((c) => c.channel === channel)?.commissionPct ?? 0;
}

export function assertValidChannelCommissionConfig(config: ChannelCommissionConfig): void {
  if (!config.channel || config.channel.trim().length === 0) {
    throw new Error("canal_invalido: el nombre del canal no puede estar vacío");
  }
  if (isDirectChannel(config.channel)) {
    throw new Error("canal_invalido: 'directo' nunca paga comisión, no se configura");
  }
  if (!Number.isFinite(config.commissionPct) || config.commissionPct < 0 || config.commissionPct > 100) {
    throw new Error(`comision_invalida: commissionPct debe estar en [0, 100], recibido ${config.commissionPct}`);
  }
}

/**
 * Agrega reservas por canal: cuenta de reservas, room-nights, ingreso neto, comisión
 * calculada y neto después de comisión -- más los 2 KPI que pide el encargo:
 * room-nights directas (absoluto) y su % sobre el total (para reporting de "cuánta
 * distribución directa" logra el hotel).
 */
export function buildChannelAttributionReport(
  reservations: readonly ReservationAttributionInput[],
  configs: readonly ChannelCommissionConfig[] = [],
): ChannelAttributionReport {
  const byChannel = new Map<string, { count: number; nights: number; revenue: number }>();
  for (const r of reservations) {
    const acc = byChannel.get(r.channel) ?? { count: 0, nights: 0, revenue: 0 };
    acc.count += 1;
    acc.nights += r.nights;
    acc.revenue = roundCurrency(acc.revenue + r.netAmount);
    byChannel.set(r.channel, acc);
  }

  const channels: ChannelAttributionSummary[] = [...byChannel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, acc]) => {
      const commissionPct = resolveCommissionPct(channel, configs);
      const commissionAmount = roundCurrency(acc.revenue * (commissionPct / 100));
      return {
        channel,
        reservationCount: acc.count,
        roomNights: acc.nights,
        netRevenue: acc.revenue,
        commissionPct,
        commissionAmount,
        netRevenueAfterCommission: roundCurrency(acc.revenue - commissionAmount),
      };
    });

  const totalRoomNights = channels.reduce((sum, c) => sum + c.roomNights, 0);
  const directRoomNights = channels.find((c) => c.channel === DIRECT_CHANNEL)?.roomNights ?? 0;
  const totalCommissionAmount = roundCurrency(channels.reduce((sum, c) => sum + c.commissionAmount, 0));

  return {
    channels,
    totalReservations: reservations.length,
    totalRoomNights,
    directRoomNights,
    directRoomNightsPct: totalRoomNights > 0 ? roundCurrency((directRoomNights / totalRoomNights) * 100) : 0,
    totalCommissionAmount,
  };
}
