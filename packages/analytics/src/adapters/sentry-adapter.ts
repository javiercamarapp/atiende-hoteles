/**
 * Adaptador real contra Sentry, H12c/LAUNCH-023. Sigue el patrón de Likida
 * (`likida/src/lib/observability/sentry.ts`, docs/referencia/
 * 08-inventario-punta-a-punta.md fila 34): **server-only por defecto** -- este adaptador
 * se instancia en `apps/api`; `apps/web` NO expone un DSN de cliente en este hito (un
 * DSN de cliente público requeriría además scrubbing de PII en el propio SDK del
 * navegador, fuera de alcance de H12c) -- ver README, sección "por qué no hay Sentry en
 * el cliente todavía".
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `dsn` real (típicamente `SENTRY_DSN`).
 */
import { AnalyticsPortUnavailableError, AnalyticsPiiError, containsLikelyPii, hasDenylistedKey, type AdapterStatus } from "../shared.ts";
import type { ErrorReporterPort, ErrorReportContext, ErrorReportLevel } from "../errorReporterPort.ts";

export interface SentryAdapterConfig {
  dsn?: string;
  environment?: string;
}

export class SentryAdapter implements ErrorReporterPort {
  private readonly available: boolean;

  constructor(private readonly config: SentryAdapterConfig) {
    this.available = Boolean(config.dsn);
  }

  status(): AdapterStatus {
    if (this.available) return { provider: "sentry", available: true, simulated: false };
    return { provider: "sentry", available: false, simulated: false, reason: "[PENDIENTE DE CREDENCIALES] falta SENTRY_DSN" };
  }

  private assertAvailable(): void {
    if (!this.available) throw new AnalyticsPortUnavailableError("sentry", "sin DSN configurado en este entorno");
  }

  private assertNoPii(context: ErrorReportContext | undefined): void {
    const badKey = hasDenylistedKey(context as Record<string, unknown> | undefined);
    if (badKey) throw new AnalyticsPiiError(badKey);
    if (containsLikelyPii(context)) throw new AnalyticsPiiError("(valor de contexto)");
  }

  captureException(error: unknown, context?: ErrorReportContext): void {
    this.assertAvailable();
    this.assertNoPii(context);
    void error;
    throw new AnalyticsPortUnavailableError("sentry", "envío real al SDK de Sentry pendiente de credenciales verificadas");
  }

  captureMessage(message: string, level?: ErrorReportLevel, context?: ErrorReportContext): void {
    this.assertAvailable();
    this.assertNoPii(context);
    void message;
    void level;
    throw new AnalyticsPortUnavailableError("sentry", "envío real al SDK de Sentry pendiente de credenciales verificadas");
  }
}
