/** `FakeErrorReporterAdapter` (`simulated: true`) -- guarda los reportes en memoria,
 *  misma validación de PII que `SentryAdapter`. */
import { AnalyticsPiiError, containsLikelyPii, hasDenylistedKey, type AdapterStatus } from "../shared.ts";
import type { ErrorReporterPort, ErrorReportContext, ErrorReportLevel } from "../errorReporterPort.ts";

export interface CapturedReport {
  kind: "exception" | "message";
  error?: unknown;
  message?: string;
  level?: ErrorReportLevel;
  context?: ErrorReportContext;
  at: string;
}

export class FakeErrorReporterAdapter implements ErrorReporterPort {
  readonly simulated = true as const;
  readonly reports: CapturedReport[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  status(): AdapterStatus {
    return { provider: "fake", available: true, simulated: true };
  }

  private assertNoPii(context: ErrorReportContext | undefined): void {
    const badKey = hasDenylistedKey(context as Record<string, unknown> | undefined);
    if (badKey) throw new AnalyticsPiiError(badKey);
    if (containsLikelyPii(context)) throw new AnalyticsPiiError("(valor de contexto)");
  }

  captureException(error: unknown, context?: ErrorReportContext): void {
    this.assertNoPii(context);
    this.reports.push({ kind: "exception", error, context, at: this.now().toISOString() });
  }

  captureMessage(message: string, level: ErrorReportLevel = "error", context?: ErrorReportContext): void {
    this.assertNoPii(context);
    this.reports.push({ kind: "message", message, level, context, at: this.now().toISOString() });
  }
}
