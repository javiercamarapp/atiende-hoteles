// H16-014 · REQ-REC-014 (P1/SEG): lee las filas reales de PMS (folio/charge/payment/
// audit_log/hotel_staff) que cada regla de packages/domain-hotel/src/fraude/deteccion.ts
// necesita, les aplica esas funciones puras, y persiste cualquier hallazgo nuevo vía
// `record_fraud_alert()` (SECURITY DEFINER, migrations/0095). Ningún cálculo de fraude
// vive aquí -- este archivo es SOLO lectura de Postgres + orquestación, mismo principio
// que jobs/nightAudit.ts con `@atiende-hoteles/domain-hotel`.
import type { DbClient } from "@atiende-hoteles/db";
import {
  detectDiscountOutsidePolicy,
  detectFolioReopenedAfterAudit,
  detectRefundToDifferentCard,
  detectUnpostedFnbCharge,
  recipientRolesForPattern,
  type FraudFinding,
} from "@atiende-hoteles/domain-hotel";
import { loadHotelMoneyConfig } from "./taxConfig.ts";

/** Insumo de venta POS de F&B (patrón 3) -- EXPLÍCITO de quien invoca el escaneo. Sin
 *  integración POS real todavía (ADR-007): este servicio nunca la simula ni la asume,
 *  solo reconcilia lo que se le entrega contra lo ya posteado en `charge`. */
export interface FnbPosSaleInput {
  posSaleId: string;
  folioId: string;
  amount: number;
}

export interface FraudScanParams {
  tenantId: string;
  hotelId: string;
  posSales?: FnbPosSaleInput[];
}

/**
 * Corre los 4 patrones del criterio de REQ-REC-014 contra los datos reales del hotel y
 * devuelve TODOS los hallazgos (nuevos o ya alertados antes -- este servicio no decide
 * idempotencia, eso lo hace `persistFraudFindings` vía el índice único de la base de
 * datos). Solo lectura: ninguna escritura ocurre en esta función.
 */
export async function scanFraudSignals(db: DbClient, params: FraudScanParams): Promise<FraudFinding[]> {
  const findings: FraudFinding[] = [];

  // ------------------------------------------------------------------------
  // 1) Descuentos fuera de política: cruza `charge` (concept='descuento') con
  // `audit_log` (quién lo aplicó, acción 'charge.discount_applied') y `hotel_staff`
  // (si esa persona tiene rol administrativo) -- reconciliación independiente de la
  // que ya hace `evaluateDiscountAuthorization` en el camino feliz de
  // routes/folios.ts (ver comentario de deteccion.ts).
  // ------------------------------------------------------------------------
  const { discountThreshold } = await loadHotelMoneyConfig(db, params.hotelId);
  const { rows: discountRows } = await db.query<{
    charge_id: string;
    folio_id: string;
    amount: string;
    discount_authorized_by: string | null;
    applied_by_role: string | null;
  }>(
    `select c.id as charge_id, c.folio_id, c.amount::text as amount, c.discount_authorized_by,
            hs.role as applied_by_role
     from public.charge c
     left join public.audit_log al
       on al.entity_type = 'charge' and al.entity_id = c.id and al.action = 'charge.discount_applied'
     left join public.hotel_staff hs
       on hs.user_id = al.actor_user_id and hs.hotel_id = c.hotel_id
     where c.hotel_id = $1 and c.concept = 'descuento' and c.reversed_by is null;`,
    [params.hotelId],
  );
  for (const row of discountRows) {
    const finding = detectDiscountOutsidePolicy({
      chargeId: row.charge_id,
      folioId: row.folio_id,
      discountAmount: Number(row.amount),
      thresholdAmount: discountThreshold,
      discountAuthorizedByStaffId: row.discount_authorized_by,
      appliedByHasAdminRole: row.applied_by_role === "owner" || row.applied_by_role === "gm",
    });
    if (finding) findings.push(finding);
  }

  // ------------------------------------------------------------------------
  // 2) Folio reabierto después de auditado: ningún endpoint de este sistema admite
  // escribir un cargo con `folio.status !== 'abierto'` (grep confirmado sobre
  // routes/folios.ts) -- cualquier cargo con `created_at` posterior a
  // `folio.closed_at` implica que el folio se reabrió fuera del flujo normal.
  // ------------------------------------------------------------------------
  const { rows: reopenRows } = await db.query<{
    folio_id: string;
    closed_at: string;
    charge_id: string;
    charge_created_at: string;
  }>(
    `select f.id as folio_id, f.closed_at::text as closed_at, c.id as charge_id, c.created_at::text as charge_created_at
     from public.folio f
     join public.charge c on c.folio_id = f.id
     where f.hotel_id = $1 and f.closed_at is not null and c.created_at > f.closed_at;`,
    [params.hotelId],
  );
  for (const row of reopenRows) {
    const finding = detectFolioReopenedAfterAudit({
      folioId: row.folio_id,
      folioClosedAt: row.closed_at,
      chargeId: row.charge_id,
      chargeCreatedAt: row.charge_created_at,
    });
    if (finding) findings.push(finding);
  }

  // ------------------------------------------------------------------------
  // 3) Cargos de F&B no posteados: reconcilia cada venta POS reportada contra el
  // cargo `concept='ab'` más reciente del mismo folio dentro de un centavo de
  // tolerancia. Sin ventas reportadas (`posSales` vacío/omitido), este patrón
  // simplemente no genera hallazgos -- mismo criterio honesto que night audit declara
  // "sin_pos_configurado" en vez de fabricar una reconciliación sin datos reales.
  // ------------------------------------------------------------------------
  for (const sale of params.posSales ?? []) {
    const { rows: matchRows } = await db.query<{ charge_id: string; amount: string }>(
      `select id as charge_id, amount::text as amount
       from public.charge
       where hotel_id = $1 and folio_id = $2 and concept = 'ab' and reversed_by is null
         and amount between $3 and $4
       order by created_at desc
       limit 1;`,
      [params.hotelId, sale.folioId, sale.amount - 0.01, sale.amount + 0.01],
    );
    const matched = matchRows[0] ? { chargeId: matchRows[0].charge_id, amount: Number(matchRows[0].amount) } : null;
    const finding = detectUnpostedFnbCharge({
      folioId: sale.folioId,
      posSaleId: sale.posSaleId,
      posSaleAmount: sale.amount,
      matchedCharge: matched,
    });
    if (finding) findings.push(finding);
  }

  // ------------------------------------------------------------------------
  // 4) Reembolsos a una tarjeta distinta de la del cargo: cualquier `payment`
  // `status='reembolsado'` cuyo `token_ref` no coincide con ningún `payment`
  // `status='capturado'` del MISMO folio.
  // ------------------------------------------------------------------------
  const { rows: refundRows } = await db.query<{ payment_id: string; folio_id: string; token_ref: string; matched: boolean }>(
    `select r.id as payment_id, r.folio_id, r.token_ref,
            exists (
              select 1 from public.payment cpt
              where cpt.folio_id = r.folio_id and cpt.status = 'capturado' and cpt.token_ref = r.token_ref
            ) as matched
     from public.payment r
     where r.hotel_id = $1 and r.status = 'reembolsado' and r.token_ref is not null;`,
    [params.hotelId],
  );
  for (const row of refundRows) {
    const finding = detectRefundToDifferentCard({
      folioId: row.folio_id,
      refundPaymentId: row.payment_id,
      refundTokenRef: row.token_ref,
      matchingCapturedTokenFound: row.matched,
    });
    if (finding) findings.push(finding);
  }

  return findings;
}

export interface PersistedFraudAlert {
  id: string;
  isNew: boolean;
  finding: FraudFinding;
}

/**
 * Persiste cada hallazgo vía `record_fraud_alert()` (idempotente por
 * `(hotel_id, dedupe_key)`, migrations/0095) y devuelve, por cada uno, si la fila era
 * nueva (`isNew`) -- el llamador (routes/fraude.ts) usa esa bandera para decidir si
 * además despacha una notificación, nunca reenvía la misma alerta dos veces.
 */
export async function persistFraudFindings(
  db: DbClient,
  params: { tenantId: string; hotelId: string },
  findings: FraudFinding[],
): Promise<PersistedFraudAlert[]> {
  const persisted: PersistedFraudAlert[] = [];
  for (const finding of findings) {
    const recipientRoles = recipientRolesForPattern(finding.pattern);
    const { rows } = await db.query<{ id: string; is_new: boolean }>(
      `select id, is_new from public.record_fraud_alert($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        params.tenantId,
        params.hotelId,
        finding.pattern,
        finding.folioId,
        finding.chargeId,
        finding.paymentId,
        finding.reason,
        JSON.stringify(finding.evidence),
        JSON.stringify(recipientRoles),
        finding.dedupeKey,
      ],
    );
    persisted.push({ id: rows[0]!.id, isNew: rows[0]!.is_new, finding });
  }
  return persisted;
}
