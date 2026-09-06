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

// auditoria-2/operabilidad [ALTO]: hasta este fix, `buildMoneyAlertLog` terminaba SIEMPRE
// como una línea más de `stdout` -- ningún mecanismo de entrega (webhook, correo, Slack,
// PagerDuty), ninguna variable de entorno que declarara "a quién avisar". REQ-BO-034
// ("alertas configurables con umbral y destinatario por tipo") sigue `pendiente` en
// docs/REQUISITOS.md; lo de aquí es el mínimo real para dejar de estar pendiente:
// - `MONEY_ALERT_WEBHOOK_URL`: si se define, cada alerta se envía por HTTP POST (JSON)
//   a esa URL -- webhook GENÉRICO (Slack Incoming Webhook, PagerDuty Events API, un
//   endpoint propio, o un relevo webhook->correo tipo Zapier/Make), sin acoplar este
//   archivo a un proveedor concreto (mismo criterio que "sin credenciales reales" del
//   resto del repo, ADR-007).
// - `MONEY_ALERT_EMAIL_TO` + `MONEY_ALERT_EMAIL_WEBHOOK_URL`: si AMBAS se definen, se
//   envía además `{ to, subject, alert }` a `MONEY_ALERT_EMAIL_WEBHOOK_URL` -- el mismo
//   patrón de "webhook genérico" pero con el destinatario de correo como campo del
//   payload, para un relevo que sepa convertir eso en un correo real (este repo no trae
//   ningún cliente SMTP/proveedor de correo propio -- fabricar uno sin credenciales
//   reales sería simular una integración que no existe).
// Si NINGUNA de las dos está configurada, `createApp()` (app.ts) emite un log de
// arranque `nivel: "alerta"` diciéndolo explícitamente (nunca falla en silencio) y
// `GET /ready` (routes/health.ts) lo refleja en su respuesta.
export interface MoneyAlertDestinationConfig {
  webhookUrl?: string;
  emailTo?: string;
  emailWebhookUrl?: string;
}

export function resolveMoneyAlertDestination(env: NodeJS.ProcessEnv = process.env): MoneyAlertDestinationConfig {
  return {
    webhookUrl: env.MONEY_ALERT_WEBHOOK_URL?.trim() || undefined,
    emailTo: env.MONEY_ALERT_EMAIL_TO?.trim() || undefined,
    emailWebhookUrl: env.MONEY_ALERT_EMAIL_WEBHOOK_URL?.trim() || undefined,
  };
}

export function hasMoneyAlertDestination(config: MoneyAlertDestinationConfig): boolean {
  return Boolean(config.webhookUrl) || Boolean(config.emailTo && config.emailWebhookUrl);
}

/** Log de arranque cuando NINGÚN destino está configurado -- `nivel: "alerta"` (mismo
 *  campo que una alerta real) para que aparezca en el mismo canal/búsqueda que las
 *  alertas de dinero de verdad, en vez de una advertencia de arranque distinta que
 *  nadie filtra igual. */
export function buildNoDestinationStartupLog(): Record<string, unknown> {
  return {
    nivel: "alerta",
    tipo: "alerta_camino_dinero_sin_destinatario",
    mensaje:
      "Las alertas del camino del dinero (cargos/pagos/CFDI/reservas con 5xx) no tienen ningún destinatario configurado " +
      "(MONEY_ALERT_WEBHOOK_URL / MONEY_ALERT_EMAIL_TO+MONEY_ALERT_EMAIL_WEBHOOK_URL). Quedan solo como líneas de log; " +
      "nadie recibe una notificación activa. REQ-BO-034 sigue pendiente.",
  };
}

/**
 * Entrega una alerta ya construida (`buildMoneyAlertLog`) al/los destino(s)
 * configurados, sin bloquear el request que la disparó (el llamador NO debe `await`
 * esto dentro del ciclo de respuesta -- ver app.ts) y sin lanzar nunca: un webhook
 * caído no debe convertirse en un segundo error encima del 5xx original. Cualquier
 * fallo de entrega se loguea (`logger`) para que quede rastro de que la alerta no
 * llegó, en vez de desaparecer en silencio -- el mismo defecto que este archivo existe
 * para corregir, ahora aplicado también a la entrega.
 */
export async function dispatchMoneyAlert(
  alert: Record<string, unknown>,
  config: MoneyAlertDestinationConfig,
  deps: { fetchFn?: typeof fetch; logger?: { error: (obj: unknown, msg?: string) => void } } = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const intentos: Promise<void>[] = [];

  if (config.webhookUrl) {
    intentos.push(
      fetchFn(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`webhook respondió ${res.status}`);
        })
        .catch((err) => {
          deps.logger?.error(
            { err: err instanceof Error ? err.message : String(err), destino: "webhook" },
            "no se pudo entregar la alerta del camino del dinero al webhook configurado",
          );
        }),
    );
  }

  if (config.emailTo && config.emailWebhookUrl) {
    intentos.push(
      fetchFn(config.emailWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: config.emailTo, subject: `[Atiende Hoteles] Alerta: ${alert.tipo}`, alert }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`webhook de correo respondió ${res.status}`);
        })
        .catch((err) => {
          deps.logger?.error(
            { err: err instanceof Error ? err.message : String(err), destino: "correo" },
            "no se pudo entregar la alerta del camino del dinero por correo",
          );
        }),
    );
  }

  await Promise.all(intentos);
}
