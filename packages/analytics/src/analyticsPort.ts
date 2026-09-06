// H12c · `AnalyticsPort` -- contrato de analítica de producto (PostHog como base,
// LAUNCH-033/inventario §"Analítica de producto"), intercambiable e inicializado SOLO
// tras consentimiento explícito (banner de cookies, ver apps/web/src/components/
// CookieConsentBanner.tsx). Ningún adaptador de este archivo debe llamarse antes de que
// `hasConsent()` sea true -- eso lo garantiza el llamador (AnalyticsProvider en web,
// lib/analytics.ts en api), no el puerto en sí.
import type { AdapterStatus } from "./shared.ts";
import type { ProductEventName } from "./events.ts";

/** Valor de propiedad de evento: JSON plano, nunca un objeto complejo/con métodos --
 *  simplifica el escaneo de PII de `containsLikelyPii`. */
export type EventProperties = Record<string, string | number | boolean | null | undefined>;

export interface AnalyticsPort {
  status(): AdapterStatus;

  /** Identifica al usuario actual por un id ESTABLE Y NO PERSONAL (uuid de
   *  `staff_user.id`, nunca el email) -- el llamador es responsable de pasar el id
   *  correcto; el puerto no puede saber si un string "parece" un uuid o un correo, por
   *  eso además se documenta aquí como contrato. */
  identify(distinctId: string, traits?: EventProperties): void;

  /** Encola/envía un evento del catálogo cerrado de `events.ts`. Lanza
   *  `AnalyticsPiiError` (sin enviar nada) si `properties` contiene una clave vedada o
   *  un patrón de PII aparente en su valor. */
  track(event: ProductEventName, properties?: EventProperties): void;

  /** Vacía cualquier cola en memoria antes de que el proceso/pestaña termine. */
  flush(): Promise<void>;
}
