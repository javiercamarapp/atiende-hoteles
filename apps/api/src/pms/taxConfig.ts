// H4 · REQ-REV-001: carga la configuración fiscal REAL del hotel (`hotel_tax_config`,
// migración 0013). Sin fila configurada, el motor de cotización NUNCA asume 0%/16% en
// silencio -- la ruta responde 400 explícito ("este hotel no tiene impuestos
// configurados todavía"), nunca un total fiscal inventado.
import type { DbClient } from "@atiende-hoteles/db";
import type { TaxConfig } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";

export async function loadTaxConfig(db: DbClient, hotelId: string): Promise<TaxConfig> {
  const { rows } = await db.query<{ iva_rate: string; ish_rate: string }>(
    "select iva_rate, ish_rate from public.hotel_tax_config where hotel_id = $1;",
    [hotelId],
  );
  const row = rows[0];
  if (!row) {
    throw Errors.validation(
      "Este hotel no tiene impuestos (IVA/ISH) configurados todavía: no se puede cotizar sin esa configuración explícita.",
    );
  }
  return { ivaRate: Number(row.iva_rate), ishRate: Number(row.ish_rate) };
}

// H5 · REQ-BO-007/REQ-REC-012 estilo: umbral de descuento y DSA por cuarto-noche son
// PARÁMETROS por hotel (migrations/0030_folio_engine.sql), nunca un valor fijo en
// código -- mismo principio que `loadTaxConfig` de arriba.
export interface HotelMoneyConfig {
  ivaRate: number;
  ishRate: number;
  discountThreshold: number;
  dsaPerNight: number;
  stateCode: string;
  rfcEmisor: string | null;
  /** REQ-AB-012/H10-020: umbral objetivo de tasa de captura de cargos (0.995 = 99.5%
   *  por defecto), parametrizado por hotel -- migración 0131. */
  chargeCaptureRateTarget: number;
}

export async function loadHotelMoneyConfig(db: DbClient, hotelId: string): Promise<HotelMoneyConfig> {
  const { rows } = await db.query<{
    iva_rate: string;
    ish_rate: string;
    discount_threshold: string;
    dsa_per_night: string;
    state_code: string;
    rfc_emisor: string | null;
    charge_capture_rate_target: string;
  }>(
    `select iva_rate, ish_rate, discount_threshold, dsa_per_night, state_code, rfc_emisor, charge_capture_rate_target
     from public.hotel_tax_config where hotel_id = $1;`,
    [hotelId],
  );
  const row = rows[0];
  if (!row) {
    throw Errors.validation(
      "Este hotel no tiene impuestos (IVA/ISH) configurados todavía: no se puede operar el folio sin esa configuración explícita.",
    );
  }
  return {
    ivaRate: Number(row.iva_rate),
    ishRate: Number(row.ish_rate),
    discountThreshold: Number(row.discount_threshold),
    dsaPerNight: Number(row.dsa_per_night),
    stateCode: row.state_code,
    rfcEmisor: row.rfc_emisor,
    chargeCaptureRateTarget: Number(row.charge_capture_rate_target),
  };
}

export interface CancellationPolicyRow {
  freeUntilHours: number;
  penaltyPct: number;
  noShowPct: number;
  depositPct: number;
}

/** `hotel_cancellation_policy` guarda los porcentajes en 0-100 y
 *  `CancellationPolicyConfig` (packages/domain-hotel/src/cancellationPolicy.ts) espera
 *  exactamente ese mismo rango 0-100 (divide entre 100 internamente al aplicar el
 *  porcentaje) — este mapeo es un passthrough 1:1, sin conversión de escala. */
export async function loadCancellationPolicy(db: DbClient, hotelId: string): Promise<CancellationPolicyRow | null> {
  const { rows } = await db.query<{
    free_until_hours: number;
    penalty_pct: string;
    no_show_pct: string;
    deposit_pct: string;
  }>(
    "select free_until_hours, penalty_pct, no_show_pct, deposit_pct from public.hotel_cancellation_policy where hotel_id = $1;",
    [hotelId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    freeUntilHours: row.free_until_hours,
    penaltyPct: Number(row.penalty_pct),
    noShowPct: Number(row.no_show_pct),
    depositPct: Number(row.deposit_pct),
  };
}
