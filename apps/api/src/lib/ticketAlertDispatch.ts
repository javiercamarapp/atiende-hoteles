// REQ-HUE-014 (ampliación "notificación activa"): la escalación automática de
// `guest_ticket` (apps/api/src/jobs/ticketEscalation.ts) hasta ahora solo cambiaba
// `status`/`escalated_at`/`escalated_to_roles` en la base y dejaba un rastro en
// `audit_log` -- ninguna notificación ACTIVA salía del proceso (verificado leyendo el
// código antes de escribir este archivo: ni un `fetch`, ni un insert a `outbox`, ni una
// llamada a ningún dispatcher). Este módulo reutiliza el MISMO mecanismo de entrega
// genérico (webhook -- Slack Incoming Webhook, PagerDuty Events API, un endpoint
// propio, o un relevo webhook->correo tipo Zapier/Make) que `lib/moneyAlert.ts`
// construyó para el camino del dinero y que `lib/fraudAlertDispatch.ts` ya reusa para
// fraude interno -- mismo principio de "nunca simular un proveedor de correo/SMS/
// WhatsApp que no existe" (ADR-007). Esta tarea prohíbe explícitamente contactar la API
// real de Meta/WhatsApp; un webhook genérico configurable es la notificación ACTIVA
// verificable sin esa credencial, exactamente el mismo criterio ya aceptado para
// REQ-REC-014 (fraude).
//
// Variables de entorno PROPIAS (con fallback a MONEY_ALERT_* si no se configuran las
// dedicadas, mismo criterio que fraudAlertDispatch.ts) para que un operador pueda
// enrutar las alertas de SLA de tickets a un canal DISTINTO del de dinero/fraude, sin
// acoplar la lógica de entrega/reintento/logging (que sigue viviendo en un único
// lugar, moneyAlert.ts).
//
// NOTA DE POSIBLE DUPLICACIÓN PARA QUIEN RESUELVA EL MERGE: esta rama
// (agent/sla-escalamiento-notificacion-activa) fue instruida explícitamente a construir
// su PROPIA función de notificación reutilizable porque un cluster en paralelo
// ("notificacion-activa-staff") puede estar construyendo un mecanismo de notificación
// activa genérico para staff al mismo tiempo, sin visibilidad mutua. Este archivo no
// tiene NADA específico de tickets salvo el nombre de sus variables de entorno y el
// campo "tipo" del payload -- es un wrapper de 3 líneas sobre `dispatchMoneyAlert`,
// idéntico en forma a `fraudAlertDispatch.ts`. Si al integrar ya existe un dispatcher de
// notificación activa genérico para staff (fuera de fraude/dinero), UNIFICAR con ese en
// vez de mantener un tercer wrapper casi idéntico; los llamadores de este archivo
// (`ticketEscalationScheduler.ts`) solo dependen de la firma
// `(alert, config, deps) => Promise<void>` + `resolveTicketAlertDestination()`, así que
// redirigir esa firma a un dispatcher unificado es un cambio mecánico y de bajo riesgo.
import { dispatchMoneyAlert, type MoneyAlertDestinationConfig } from "./moneyAlert.ts";

export type TicketAlertDestinationConfig = MoneyAlertDestinationConfig;

export function resolveTicketAlertDestination(env: NodeJS.ProcessEnv = process.env): TicketAlertDestinationConfig {
  return {
    webhookUrl: env.TICKET_ALERT_WEBHOOK_URL?.trim() || env.MONEY_ALERT_WEBHOOK_URL?.trim() || undefined,
    emailTo: env.TICKET_ALERT_EMAIL_TO?.trim() || env.MONEY_ALERT_EMAIL_TO?.trim() || undefined,
    emailWebhookUrl: env.TICKET_ALERT_EMAIL_WEBHOOK_URL?.trim() || env.MONEY_ALERT_EMAIL_WEBHOOK_URL?.trim() || undefined,
  };
}

export function hasTicketAlertDestination(config: TicketAlertDestinationConfig): boolean {
  return Boolean(config.webhookUrl) || Boolean(config.emailTo && config.emailWebhookUrl);
}

/** Mismo cuerpo de entrega que `dispatchMoneyAlert`/`dispatchFraudAlert` (nunca lanza,
 *  reporta fallos de entrega al logger inyectado, no bloquea al llamador) -- reexportado
 *  con su propio nombre para que `ticketEscalationScheduler.ts` no importe algo llamado
 *  "money" para una alerta que no lo es. */
export const dispatchTicketAlert = dispatchMoneyAlert;
