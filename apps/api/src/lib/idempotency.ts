// H2 · ADR-004: Idempotency-Key obligatorio en POST de reserva/cargo/pago. Patrón
// INSERT ... ON CONFLICT DO NOTHING (mismo patrón verificado en
// docs/referencia/07-stack-viabilidad.md Experimento 1): la fila de reclamo se inserta
// ANTES de ejecutar la mutación, dentro de la MISMA transacción de sesión de la request
// (ADR-004 "middleware que abre transacción por request"). Esto da, gratis, la
// serialización correcta bajo concurrencia real (embedded-postgres): un INSERT que
// choca contra una fila con la misma llave única insertada por OTRA transacción en
// vuelo espera a que esa transacción termine (commit o rollback) antes de resolver el
// conflicto — ver README de esta carpeta para el razonamiento completo.
import { createHash } from "node:crypto";
import type { DbClient } from "@atiende-hoteles/db";
import { Errors } from "./errors.ts";

export interface IdempotentResult {
  status: number;
  body: unknown;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Ejecuta `run()` de forma idempotente por `(tenantId, scope, key)`.
 * - Sin fila previa: reclama la llave, corre `run()`, guarda la respuesta.
 * - Misma llave + mismo cuerpo: devuelve la respuesta ya guardada (si `run()` de la
 *   primera solicitud aún no terminó, esta llamada espera el commit/rollback de esa
 *   transacción antes de continuar — ver comentario de arriba).
 * - Misma llave + cuerpo distinto: 422 (`Errors.idempotencyConflict`).
 */
export async function withIdempotency(
  session: DbClient,
  params: { tenantId: string; scope: string; key: string; body: unknown },
  run: () => Promise<IdempotentResult>,
): Promise<IdempotentResult> {
  const requestHash = hashBody(params.body);

  const claim = await session.query<{ id: string }>(
    `insert into public.idempotency_key (tenant_id, scope, key, request_hash)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, scope, key) do nothing
     returning id;`,
    [params.tenantId, params.scope, params.key, requestHash],
  );

  if (claim.rows.length === 0) {
    const existing = await session.query<{ request_hash: string | null; response: IdempotentResult | null }>(
      `select request_hash, response from public.idempotency_key
       where tenant_id = $1 and scope = $2 and key = $3;`,
      [params.tenantId, params.scope, params.key],
    );
    const row = existing.rows[0];
    if (!row) {
      // La fila que causó el conflicto se revirtió (rollback) entre el INSERT y este
      // SELECT: trátese como si nunca hubiera existido, reintenta una sola vez.
      return withIdempotency(session, params, run);
    }
    if (row.request_hash !== requestHash) {
      throw Errors.idempotencyConflict();
    }
    if (row.response == null) {
      // La solicitud original sigue "reclamada" sin respuesta guardada (no debería
      // ocurrir dentro de la misma transacción salvo error de programación aguas
      // arriba); se documenta en vez de colgar el request indefinidamente.
      throw Errors.conflict("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
    }
    return row.response;
  }

  const result = await run();

  await session.query(
    `update public.idempotency_key set response = $1 where tenant_id = $2 and scope = $3 and key = $4;`,
    [JSON.stringify(result), params.tenantId, params.scope, params.key],
  );

  return result;
}
