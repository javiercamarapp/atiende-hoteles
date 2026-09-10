// H12c · Analítica de producto SOLO tras consentimiento explícito (banner de cookies,
// ver components/CookieConsentBanner.tsx) -- respeta el aviso de privacidad del lote A
// (apps/web/src/pages/Privacidad.tsx). Antes de que el visitante decida, o si rechaza,
// se usa `FakeAnalyticsAdapter`/`FakeErrorReporterAdapter` (`simulated: true`): los
// eventos se calculan/validan igual (misma detección de PII) pero NUNCA salen del
// navegador -- ver packages/analytics/README.md.
import {
  FakeAnalyticsAdapter,
  FakeErrorReporterAdapter,
  PostHogAdapter,
  AnalyticsPiiError,
  type AnalyticsPort,
  type ErrorReporterPort,
  type EventProperties,
  type ProductEventName,
  type ErrorReportContext,
} from "@atiende-hoteles/analytics";

const CONSENT_KEY = "atiende_hoteles_consentimiento_analitica";
export type Consentimiento = "otorgado" | "rechazado";

export function leerConsentimiento(): Consentimiento | null {
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    return raw === "otorgado" || raw === "rechazado" ? raw : null;
  } catch {
    // Un navegador que bloquea localStorage (modo privado estricto) se trata como "sin
    // decisión todavía" -- el banner se vuelve a mostrar, nunca se asume consentimiento.
    return null;
  }
}

function guardarConsentimiento(valor: Consentimiento): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, valor);
  } catch {
    // Best-effort: si no se puede persistir, el banner reaparecerá la próxima carga --
    // preferible a fallar la interacción del usuario.
  }
}

let analyticsPort: AnalyticsPort = new FakeAnalyticsAdapter();
const errorReporterPort: ErrorReporterPort = new FakeErrorReporterAdapter();

function activarAdaptadorReal(): void {
  const apiKey = (import.meta.env.VITE_POSTHOG_KEY as string | undefined) || undefined;
  const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || undefined;
  analyticsPort = new PostHogAdapter({ apiKey, host });
  // Sentry de cliente deliberadamente NO se activa en este hito -- ver
  // packages/analytics/README.md ("por qué no hay DSN de cliente todavía").
}

function desactivarAdaptadorReal(): void {
  analyticsPort = new FakeAnalyticsAdapter();
}

/** Se llama una vez al montar la app -- si ya hubo consentimiento en una visita previa,
 *  activa el adaptador real de inmediato (sin volver a preguntar). */
export function inicializarAnalitica(): void {
  if (leerConsentimiento() === "otorgado") activarAdaptadorReal();
}

export function otorgarConsentimiento(): void {
  guardarConsentimiento("otorgado");
  activarAdaptadorReal();
  track("cookie_consent_granted");
}

export function revocarConsentimiento(): void {
  track("cookie_consent_revoked");
  guardarConsentimiento("rechazado");
  desactivarAdaptadorReal();
}

/** Envía un evento del catálogo cerrado (packages/analytics/src/events.ts). Si contiene
 *  un patrón de PII aparente, se bloquea y se registra una advertencia en consola --
 *  NUNCA lanza hacia el componente que llama (la analítica jamás debe romper la UI). */
export function track(event: ProductEventName, properties?: EventProperties): void {
  try {
    analyticsPort.track(event, properties);
  } catch (err) {
    if (err instanceof AnalyticsPiiError) {
      console.warn(`[analytics] evento "${event}" bloqueado: ${err.message}`);
      return;
    }
    console.warn(`[analytics] no se pudo registrar "${event}":`, err);
  }
}

export function reportarError(error: unknown, context?: ErrorReportContext): void {
  try {
    errorReporterPort.captureException(error, context);
  } catch (err) {
    console.warn("[error-reporter] no se pudo reportar el error:", err);
  }
}
