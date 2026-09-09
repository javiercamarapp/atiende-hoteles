/**
 * Adaptador real contra PostHog (Capture API), H12c. Esqueleto honesto: sin
 * `apiKey`/`host` configurados, `status()` reporta `unavailable` y `track()`/`identify()`
 * lanzan `AnalyticsPortUnavailableError` en vez de silenciosamente no hacer nada (un
 * "no-op silencioso" escondería que la analítica nunca se activó). La config (apiKey/
 * host) se recibe por CONSTRUCTOR, no se lee de `process.env`/`import.meta.env` aquí
 * adentro: este paquete corre tanto en Node (apps/api) como en el navegador (apps/web
 * vía Vite) y cada entorno lee sus variables de forma distinta -- leerlas aquí acoplaría
 * el paquete a un solo entorno.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere un proyecto PostHog real (`apiKey`/`host`,
 * típicamente `VITE_POSTHOG_KEY`/`POSTHOG_API_KEY` según el lado que lo instancie).
 */
import { AnalyticsPortUnavailableError, AnalyticsPiiError, containsLikelyPii, hasDenylistedKey, type AdapterStatus } from "../shared.ts";
import type { AnalyticsPort, EventProperties } from "../analyticsPort.ts";
import type { ProductEventName } from "../events.ts";

export interface PostHogAdapterConfig {
  apiKey?: string;
  /** p. ej. `https://us.i.posthog.com`. */
  host?: string;
}

export class PostHogAdapter implements AnalyticsPort {
  private readonly available: boolean;

  constructor(private readonly config: PostHogAdapterConfig) {
    this.available = Boolean(config.apiKey && config.host);
  }

  status(): AdapterStatus {
    if (this.available) return { provider: "posthog", available: true, simulated: false };
    return {
      provider: "posthog",
      available: false,
      simulated: false,
      reason: "[PENDIENTE DE CREDENCIALES] falta apiKey/host de PostHog",
    };
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new AnalyticsPortUnavailableError("posthog", "sin apiKey/host configurados en este entorno");
    }
  }

  private assertNoPii(properties: EventProperties | undefined): void {
    const badKey = hasDenylistedKey(properties as Record<string, unknown> | undefined);
    if (badKey) throw new AnalyticsPiiError(badKey);
    if (containsLikelyPii(properties)) throw new AnalyticsPiiError("(valor de propiedad)");
  }

  identify(distinctId: string, traits?: EventProperties): void {
    this.assertAvailable();
    this.assertNoPii(traits);
    void distinctId;
    throw new AnalyticsPortUnavailableError("posthog", "envío real a la Capture API pendiente de credenciales verificadas");
  }

  track(event: ProductEventName, properties?: EventProperties): void {
    this.assertAvailable();
    this.assertNoPii(properties);
    void event;
    throw new AnalyticsPortUnavailableError("posthog", "envío real a la Capture API pendiente de credenciales verificadas");
  }

  async flush(): Promise<void> {
    // Sin credenciales no hay cola que vaciar -- no-op explícito y documentado, distinto
    // de track()/identify() (que sí deben fallar ruidosamente).
  }
}
