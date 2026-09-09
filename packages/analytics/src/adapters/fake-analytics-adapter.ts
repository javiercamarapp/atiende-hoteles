/**
 * `FakeAnalyticsAdapter` (`simulated: true`) -- adaptador por defecto sin credenciales de
 * PostHog. Guarda los eventos en memoria (`events`) para que las pantallas/pruebas
 * puedan inspeccionar qué se hubiera enviado, y aplica LAS MISMAS validaciones de PII
 * que el adaptador real (nunca "en modo simulado dejamos pasar cualquier cosa" -- el
 * bloqueo de PII debe probarse igual de estricto contra el fake que se usa en CI).
 */
import { AnalyticsPiiError, containsLikelyPii, hasDenylistedKey, type AdapterStatus } from "../shared.ts";
import type { AnalyticsPort, EventProperties } from "../analyticsPort.ts";
import type { ProductEventName } from "../events.ts";

export interface CapturedEvent {
  event: ProductEventName;
  properties?: EventProperties;
  at: string;
}

export class FakeAnalyticsAdapter implements AnalyticsPort {
  readonly simulated = true as const;
  readonly events: CapturedEvent[] = [];
  readonly identifications: { distinctId: string; traits?: EventProperties }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  status(): AdapterStatus {
    return { provider: "fake", available: true, simulated: true };
  }

  private assertNoPii(properties: EventProperties | undefined): void {
    const badKey = hasDenylistedKey(properties as Record<string, unknown> | undefined);
    if (badKey) throw new AnalyticsPiiError(badKey);
    if (containsLikelyPii(properties)) throw new AnalyticsPiiError("(valor de propiedad)");
  }

  identify(distinctId: string, traits?: EventProperties): void {
    this.assertNoPii(traits);
    this.identifications.push({ distinctId, traits });
  }

  track(event: ProductEventName, properties?: EventProperties): void {
    this.assertNoPii(properties);
    this.events.push({ event, properties, at: this.now().toISOString() });
  }

  async flush(): Promise<void> {
    // En memoria: no hay red que vaciar.
  }
}
