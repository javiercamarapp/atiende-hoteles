// REQ-SEG-009 (H19-010/BP-153) · "Debe existir un procedimiento documentado y probado de
// notificación de brechas de seguridad (detección, evaluación, notificación al afectado
// y a la autoridad en plazo); una brecha de datos de pasaporte se considera vulneración
// significativa que requiere notificación obligatoria." El procedimiento HUMANO vive en
// `docs/runbooks/incidentes.md` §1 -- este archivo es el MECANISMO TÉCNICO real que ese
// runbook referencia: exactamente el mismo patrón ya aceptado para el camino del dinero
// (`lib/moneyAlert.ts`, ADR-008) aplicado a una brecha de seguridad declarada por
// owner/gm (`routes/incidentes.ts`).
//
// LÍMITE EXPLICITO (igual que moneyAlert.ts): el DESTINO final de producción (un canal
// real de Slack/PagerDuty/correo con credenciales reales) sigue sin configurarse en este
// entorno (ADR-007, "pendiente de credenciales") -- lo que este archivo entrega es el
// mecanismo GENÉRICO de entrega por webhook (nunca acoplado a un proveedor concreto) más
// la detección/registro inmutable del incidente, ya probado de punta a punta con un
// servidor HTTP real en tests/integration/api/incidentes.spec.ts (nunca solo con un
// `fetch` sustituido) -- lo único que falta para producción es la URL/credencial real del
// destino elegido por el fundador, no código.
export interface SecurityBreachAlertContext {
  incidentId: string;
  requestId: string;
  orgId: string;
  hotelId: string;
  actorId?: string;
  categoria: string;
  descripcion: string;
  datosInvolucrados: string[];
  /** REQ-SEG-009: "una brecha de datos de pasaporte se considera vulneración
   *  significativa que requiere notificación obligatoria" -- ver
   *  `esVulneracionSignificativa()` abajo para el criterio exacto. */
  vulneracionSignificativa: boolean;
  detectadoEn: string;
}

// REQ-SEG-009 (texto explícito del requisito): "una brecha de datos de PASAPORTE se
// considera vulneración significativa". Se generaliza a cualquier documento de identidad
// de la bóveda (REQ-SEG-014: pasaporte/INE) y a credenciales fiscales (REQ-SEG-010,
// e.firma/CSD) -- mismo criterio de "dato cuya exposición por sí sola ya es grave" que el
// resto de este repo aplica (ver REQ-SEG-005 PAN, REQ-SEG-012). Nunca se infiere de
// texto libre: el catálogo es explícito y cerrado a propósito, para que declarar una
// categoría nueva sea una decisión consciente de quien edita este archivo, no una
// coincidencia de substring.
const CATEGORIAS_VULNERACION_SIGNIFICATIVA = new Set([
  "pasaporte",
  "ine",
  "documento_identidad",
  "efirma",
  "csd",
  "credencial_fiscal",
]);

export function esVulneracionSignificativa(datosInvolucrados: readonly string[]): boolean {
  return datosInvolucrados.some((d) => CATEGORIAS_VULNERACION_SIGNIFICATIVA.has(d));
}

/** Forma exacta del log de alerta de brecha de seguridad: `nivel: "alerta"` explícito
 *  (mismo criterio que ADR-008/moneyAlert.ts) para que aparezca en el mismo canal/
 *  búsqueda que cualquier otra alerta operativa, sin depender de filtrar por tipo. */
export function buildSecurityBreachAlertLog(ctx: SecurityBreachAlertContext): Record<string, unknown> {
  return {
    nivel: "alerta",
    tipo: "brecha_seguridad_detectada",
    incident_id: ctx.incidentId,
    request_id: ctx.requestId,
    org_id: ctx.orgId,
    hotel_id: ctx.hotelId,
    actor_id: ctx.actorId,
    categoria: ctx.categoria,
    descripcion: ctx.descripcion,
    datos_involucrados: ctx.datosInvolucrados,
    vulneracion_significativa: ctx.vulneracionSignificativa,
    detectado_en: ctx.detectadoEn,
  };
}

export interface SecurityBreachAlertDestinationConfig {
  webhookUrl?: string;
  emailTo?: string;
  emailWebhookUrl?: string;
}

/** Mismo par de variables de entorno que `MONEY_ALERT_*` (moneyAlert.ts) pero con su
 *  propio namespace -- una brecha de seguridad puede necesitar avisar a alguien
 *  distinto (responsable de datos/legal) de quien atiende alertas de dinero. */
export function resolveSecurityBreachAlertDestination(
  env: NodeJS.ProcessEnv = process.env,
): SecurityBreachAlertDestinationConfig {
  return {
    webhookUrl: env.SECURITY_BREACH_ALERT_WEBHOOK_URL?.trim() || undefined,
    emailTo: env.SECURITY_BREACH_ALERT_EMAIL_TO?.trim() || undefined,
    emailWebhookUrl: env.SECURITY_BREACH_ALERT_EMAIL_WEBHOOK_URL?.trim() || undefined,
  };
}

export function hasSecurityBreachAlertDestination(config: SecurityBreachAlertDestinationConfig): boolean {
  return Boolean(config.webhookUrl) || Boolean(config.emailTo && config.emailWebhookUrl);
}

/** Log de arranque cuando NINGÚN destino está configurado -- mismo criterio que
 *  `buildNoDestinationStartupLog` de moneyAlert.ts: `nivel: "alerta"` desde el arranque
 *  del proceso, nunca un fallo silencioso descubierto solo cuando una brecha real ya
 *  ocurrió y nadie la vio. */
export function buildNoDestinationStartupLog(): Record<string, unknown> {
  return {
    nivel: "alerta",
    tipo: "alerta_brecha_seguridad_sin_destinatario",
    mensaje:
      "Las alertas de brecha de seguridad (REQ-SEG-009) no tienen ningún destinatario configurado " +
      "(SECURITY_BREACH_ALERT_WEBHOOK_URL / SECURITY_BREACH_ALERT_EMAIL_TO+SECURITY_BREACH_ALERT_EMAIL_WEBHOOK_URL). " +
      "Una brecha declarada vía POST /hoteles/:hotelId/incidentes/brecha queda igual registrada de forma " +
      "inmutable en audit_log, pero nadie recibe una notificación activa -- ver docs/runbooks/incidentes.md §1.6.",
  };
}

/**
 * Entrega una alerta ya construida (`buildSecurityBreachAlertLog`) al/los destino(s)
 * configurados -- MISMO mecanismo genérico de webhook que `dispatchMoneyAlert`
 * (moneyAlert.ts): sin acoplarse a Slack/PagerDuty/correo concretos, nunca lanza (un
 * webhook caído no debe impedir que la brecha quede registrada/respondida), y cualquier
 * fallo de entrega se loguea para que quede rastro explícito de que la notificación NO
 * llegó, en vez de desaparecer en silencio.
 */
export async function dispatchSecurityBreachAlert(
  alert: Record<string, unknown>,
  config: SecurityBreachAlertDestinationConfig,
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
            "no se pudo entregar la alerta de brecha de seguridad al webhook configurado",
          );
        }),
    );
  }

  if (config.emailTo && config.emailWebhookUrl) {
    intentos.push(
      fetchFn(config.emailWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: config.emailTo, subject: `[Atiende Hoteles] Brecha de seguridad: ${alert.categoria}`, alert }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`webhook de correo respondió ${res.status}`);
        })
        .catch((err) => {
          deps.logger?.error(
            { err: err instanceof Error ? err.message : String(err), destino: "correo" },
            "no se pudo entregar la alerta de brecha de seguridad por correo",
          );
        }),
    );
  }

  await Promise.all(intentos);
}
