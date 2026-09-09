// H12c · LAUNCH-015: capa de aplicación sobre `public.check_entitlement()`/
// `public.entitlement_usage()` (packages/db/migrations/0111). El bloqueo REAL vive en
// Postgres (fail-closed incluso si algún caller de apps/api olvida llamar a esta
// función), pero traducirlo a un 402 con mensaje explícito (nunca un 500 genérico) es
// responsabilidad de la capa HTTP -- ver `apps/api/src/lib/errors.ts`
// (`entitlement_exceeded:<recurso>`).
//
// PENDIENTE DE CABLEAR (documentado, no simulado): este middleware está listo para
// usarse en cualquier ruta de creación de hotel/habitación/agente/mensaje, pero
// `routes/hoteles.ts` (alta de hotel/registro, H12a), `routes/agentes.ts` (activar
// agente) y `routes/mensajeria.ts` (enviar mensaje) son propiedad de otros agentes
// trabajando en paralelo en este mismo hito (H12a onboarding/registro, lote B/C) -- no
// se editan aquí para evitar colisión de merge. Quien mergee esos módulos debe añadir
// `requireEntitlement("hoteles" | "habitaciones" | "agentes_activos" | "mensajes_mes")`
// al middleware chain de su endpoint de creación correspondiente (ver el ejemplo real
// en `routes/suscripcion.ts`, endpoint `POST /hoteles/:hotelId/entitlement/verificar`,
// usado también por `tests/adversarial/facturacion-saas.spec.ts`).
import type { MiddlewareHandler } from "hono";
import { Errors } from "./errors.ts";
import type { HonoEnvBindings } from "../types.ts";

export type EntitlementResource = "hoteles" | "habitaciones" | "agentes_activos" | "mensajes_mes";

function entitlementErrorFromMessage(message: string): ReturnType<typeof Errors.entitlementExceeded> | null {
  const match = /entitlement_exceeded:(\w+)/.exec(message);
  if (!match) return null;
  const resource = match[1];
  if (resource === "sin_suscripcion") {
    return Errors.entitlementExceeded("Esta organización no tiene una suscripción activa.");
  }
  if (resource === "suscripcion_inactiva") {
    return Errors.entitlementExceeded("La suscripción está vencida o cancelada. Actualiza tu método de pago en /suscripcion.");
  }
  return Errors.entitlementExceeded(`Se alcanzó el límite del plan contratado (${resource}). Mejora tu plan en /suscripcion.`);
}

/** Llama a `public.check_entitlement()` bajo la sesión RLS actual (el propio `orgId` se
 *  resuelve del claim de sesión, nunca de un parámetro de la petición) y lanza un
 *  `ApiError` 402 explícito si se excedería el límite -- nunca un bloqueo silencioso. */
export async function assertEntitlement(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  resource: EntitlementResource,
  wantedIncrement = 1,
): Promise<void> {
  try {
    await db.query("select public.check_entitlement($1, $2, $3);", [orgId, resource, wantedIncrement]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const apiError = entitlementErrorFromMessage(message);
    if (apiError) throw apiError;
    throw err;
  }
}

/** Middleware listo para usar en cualquier ruta de creación (`c.get("orgId")` ya debe
 *  estar resuelto por `requireHotelMembership`, que corre ANTES en la cadena). */
export function requireEntitlement(resource: EntitlementResource, wantedIncrement = 1): MiddlewareHandler<HonoEnvBindings> {
  return async (c, next) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    await assertEntitlement(db, orgId, resource, wantedIncrement);
    await next();
  };
}
