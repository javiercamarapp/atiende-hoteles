// H12c · Catálogo cerrado de eventos de producto (REQ-GOB "lista de eventos de
// analítica documentada"). `track()` (ver analyticsPort.ts) solo acepta nombres de esta
// lista -- un nombre libre/ad-hoc no compila, para que el catálogo documentado sea
// también la única fuente real de lo que se mide (nunca diverge del código).
export const PRODUCT_EVENTS = [
  { name: "landing_viewed", description: "Se cargó la landing pública (/)." },
  { name: "landing_cta_clicked", description: "Click en un CTA de la landing (registro o demo)." },
  { name: "cookie_consent_granted", description: "El visitante aceptó el banner de cookies/analítica." },
  { name: "cookie_consent_revoked", description: "El visitante revocó el consentimiento de analítica." },
  { name: "login_succeeded", description: "Inicio de sesión exitoso del panel." },
  { name: "subscription_viewed", description: "Se abrió /suscripcion." },
  { name: "subscription_upgrade_clicked", description: "Click en 'mejorar plan' desde /suscripcion." },
  { name: "subscription_checkout_started", description: "Se creó una sesión de checkout de facturación." },
  { name: "subscription_portal_opened", description: "Se abrió el portal de autoservicio del cliente." },
  { name: "entitlement_limit_blocked", description: "Una acción se bloqueó por exceder el límite del plan." },
  { name: "notification_opened", description: "Se abrió la campana/lista de notificaciones." },
  { name: "notification_marked_all_read", description: "Se usó 'marcar todo como leído'." },
  { name: "agent_approval_reviewed", description: "Un staff aprobó/rechazó una acción de agente." },
] as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[number]["name"];

export const PRODUCT_EVENT_NAMES: readonly ProductEventName[] = PRODUCT_EVENTS.map((e) => e.name);
