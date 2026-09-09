// H16-014 · REQ-REC-014: reusa el MISMO mecanismo de entrega genérico (webhook --
// Slack Incoming Webhook, PagerDuty Events API, un endpoint propio, o un relevo
// webhook->correo tipo Zapier/Make -- y opcionalmente correo vía webhook-relevo) que
// `lib/moneyAlert.ts` ya construyó para "errores del camino del dinero" (REQ-BO-034
// sigue pendiente): mismo principio de "nunca simular un proveedor de correo/SMS que
// no existe" (ADR-007). Variables de entorno PROPIAS (con fallback a las de
// MONEY_ALERT_* si no se configuran las dedicadas) para que un operador pueda enrutar
// las alertas de fraude interno a un canal DISTINTO (p.ej. seguridad/dueño) del canal
// de errores técnicos del camino del dinero, sin acoplar ambos tipos de alerta ni
// duplicar la lógica de entrega/reintento/logging (que sigue viviendo en un único
// lugar, moneyAlert.ts).
import { dispatchMoneyAlert, type MoneyAlertDestinationConfig } from "./moneyAlert.ts";

export type FraudAlertDestinationConfig = MoneyAlertDestinationConfig;

export function resolveFraudAlertDestination(env: NodeJS.ProcessEnv = process.env): FraudAlertDestinationConfig {
  return {
    webhookUrl: env.FRAUD_ALERT_WEBHOOK_URL?.trim() || env.MONEY_ALERT_WEBHOOK_URL?.trim() || undefined,
    emailTo: env.FRAUD_ALERT_EMAIL_TO?.trim() || env.MONEY_ALERT_EMAIL_TO?.trim() || undefined,
    emailWebhookUrl: env.FRAUD_ALERT_EMAIL_WEBHOOK_URL?.trim() || env.MONEY_ALERT_EMAIL_WEBHOOK_URL?.trim() || undefined,
  };
}

export function hasFraudAlertDestination(config: FraudAlertDestinationConfig): boolean {
  return Boolean(config.webhookUrl) || Boolean(config.emailTo && config.emailWebhookUrl);
}

/** Mismo cuerpo de entrega que `dispatchMoneyAlert` (nunca lanza, reporta fallos de
 *  entrega al logger inyectado) -- reexportado con su propio nombre para que
 *  routes/fraude.ts no tenga que importar algo llamado "money" para una alerta que no
 *  lo es. */
export const dispatchFraudAlert = dispatchMoneyAlert;
