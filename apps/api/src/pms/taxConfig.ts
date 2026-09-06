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
