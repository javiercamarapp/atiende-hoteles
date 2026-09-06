// H8 · ADR-008: "errores del camino del dinero con alerta estructurada". Detecta si una
// ruta pertenece al camino del dinero (cargos/pagos/CFDI/reservas, ver ADR-004 rutas de
// `folios.ts`/`reservas.ts`) por el PATRÓN de ruta (`c.req.routePath`, nunca el path
// crudo con IDs) para no acoplarse al código de esas rutas -- H5 es dueño de
// folios/night-audit/cfdi, este archivo vive en `apps/api/src/lib` (índice compartido)
// y no importa nada de `routes/folios.ts` ni `routes/reservas.ts`.
const MONEY_PATH_MARKERS = ["/pagos", "/cargos", "/cfdi", "/folios", "/reservas"];

export function isMoneyPath(routePath: string): boolean {
  return MONEY_PATH_MARKERS.some((marker) => routePath.includes(marker));
}

export interface MoneyAlertContext {
  requestId: string;
  route: string;
  method: string;
  status: number;
  orgId?: string;
  hotelId?: string;
  userId?: string;
  errorMessage?: string;
}

/** Forma exacta del log de alerta del camino del dinero: `nivel: "alerta"` explícito
 *  (ADR-008), nunca solo `level: "error"` de pino -- un humano/alertmanager que busque
 *  `nivel:"alerta"` en los logs debe encontrar TODO error 5xx en dinero, sin depender
 *  de filtrar por código de ruta a mano. */
export function buildMoneyAlertLog(ctx: MoneyAlertContext): Record<string, unknown> {
  return {
    nivel: "alerta",
    tipo: "error_camino_dinero",
    request_id: ctx.requestId,
    route: ctx.route,
    method: ctx.method,
    status: ctx.status,
    org_id: ctx.orgId,
    hotel_id: ctx.hotelId,
    user_id: ctx.userId,
    error: ctx.errorMessage,
  };
}
