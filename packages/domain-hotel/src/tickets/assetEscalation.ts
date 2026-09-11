// REQ-HK-012 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe enriquecer cada
// ticket con el historial del activo asociado, escalando automáticamente tras N tickets
// repetidos en X días sobre el mismo activo." Puro, sin I/O (mismo principio que
// tickets/slaPolicy.ts y fraude/deteccion.ts): la decisión de escalar depende SOLO del
// conteo de tickets ya observado en la ventana y de la política configurada -- nunca
// consulta la base de datos ni el reloj real por su cuenta, para que sea 100%
// reproducible en pruebas (contar es responsabilidad del llamador con I/O real, ver
// `packages/agent-core/src/tools/housekeepingTools.ts`).

export interface AssetEscalationPolicy {
  /** N: número de tickets del mismo activo dentro de la ventana que dispara la
   *  escalación (inclusive -- ver `shouldEscalateAsset`). */
  readonly thresholdCount: number;
  /** X: tamaño en días de la ventana en la que se cuentan tickets "repetidos". */
  readonly windowDays: number;
}

/** Default de negocio (3 tickets en 14 días) cuando el hotel no configuró su propia fila
 *  en `maintenance_escalation_policy` -- mismo espíritu de placeholder documentado que
 *  `DEFAULT_SLA_MINUTES_BY_PRIORITY` (tickets/slaPolicy.ts): un umbral razonable que el
 *  hotel puede sobreescribir vía configuración, nunca el definitivo de nadie. */
export const DEFAULT_ASSET_ESCALATION_POLICY: AssetEscalationPolicy = {
  thresholdCount: 3,
  windowDays: 14,
};

/** Política efectiva: la fila configurada por el hotel (`maintenance_escalation_policy`)
 *  si existe y es válida (> 0 en ambos campos), si no el default de arriba -- mismo
 *  criterio de "configurado o default por campo" que `resolveSlaMinutes`
 *  (tickets/slaPolicy.ts), nunca mezcla un campo configurado con el otro en default
 *  parcialmente inválido: una fila con `windowDays` inválido cae COMPLETA al default,
 *  no solo ese campo, para no combinar un N configurado con una X inconsistente que
 *  nadie decidió junto.
 */
export function resolveAssetEscalationPolicy(
  configured: Partial<AssetEscalationPolicy> | null | undefined,
): AssetEscalationPolicy {
  const thresholdCount = configured?.thresholdCount;
  const windowDays = configured?.windowDays;
  if (thresholdCount != null && thresholdCount > 0 && windowDays != null && windowDays > 0) {
    return { thresholdCount, windowDays };
  }
  return DEFAULT_ASSET_ESCALATION_POLICY;
}

/** Inicio de la ventana de conteo (`now - windowDays`) -- expuesto para que el llamador
 *  con I/O real arme su propia consulta (`created_at >= computeEscalationWindowStart(...)`)
 *  sin reimplementar la aritmética de días en cada sitio, y para que las pruebas puedan
 *  verificar el límite exacto sin tocar Postgres. */
export function computeEscalationWindowStart(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
}

/** `true` cuando el conteo de tickets del mismo activo dentro de la ventana -- SIEMPRE
 *  incluyendo el ticket recién creado que disparó esta evaluación, nunca solo "los
 *  anteriores" -- alcanza o supera el umbral configurado ("N tickets repetidos" cuenta
 *  desde el primero, no desde N+1). Comparación `>=` (no `>`): al llegar exactamente al
 *  umbral N ya escala, mismo criterio inclusive documentado en el criterio de
 *  aceptación ("verificado con N+1 repeticiones" -- una repetición extra de margen
 *  sobre el umbral exacto, no el límite mismo). */
export function shouldEscalateAsset(ticketsInWindowIncludingNew: number, policy: AssetEscalationPolicy): boolean {
  return ticketsInWindowIncludingNew >= policy.thresholdCount;
}

/** Roles destinatarios por defecto de la escalación por repetición -- mismo trío
 *  gm+owner que `escalateOverdueGuestTickets` (apps/api/src/jobs/ticketEscalation.ts):
 *  el técnico/departamento original ya reportó N veces sin que el problema se resolviera
 *  de raíz, así que la escalación sube un nivel jerárquico, no se reasigna al mismo
 *  departamento. */
export const DEFAULT_ASSET_ESCALATION_ROLES: readonly string[] = ["gm", "owner"];

/** Una entrada del historial de un activo -- forma mínima que necesita el llamador para
 *  enriquecer la respuesta de un ticket con "qué más le ha pasado a este equipo"
 *  (REQ-HK-012 "enriquecer cada ticket con el historial del activo asociado"). Los
 *  campos vienen de `maintenance_ticket` ya consultado con I/O real; esta interfaz solo
 *  documenta la forma esperada, no ejecuta ninguna consulta. */
export interface AssetTicketHistoryEntry {
  readonly ticketId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly createdAt: string;
}
