// H12c · `ErrorReporterPort` -- contrato de observabilidad de errores (Sentry como
// base, LAUNCH-023). Sigue el patrón de Likida (`likida/src/lib/observability/
// sentry.ts`, referenciado en docs/referencia/08-inventario-punta-a-punta.md fila 34):
// **solo server-side** por defecto -- ver README, "por qué no hay DSN de cliente todavía".
import type { AdapterStatus } from "./shared.ts";

export type ErrorReportLevel = "info" | "warning" | "error";

export interface ErrorReportContext {
  route?: string;
  requestId?: string;
  orgId?: string;
  hotelId?: string;
  /** Id de usuario NO personal (uuid), nunca email/nombre -- mismo contrato que
   *  `AnalyticsPort.identify`. */
  userId?: string;
  [key: string]: string | undefined;
}

export interface ErrorReporterPort {
  status(): AdapterStatus;

  /** Reporta una excepción. Lanza `AnalyticsPiiError` (sin reportar nada) si `context`
   *  contiene una clave vedada o un patrón de PII aparente en su valor -- el mensaje de
   *  la excepción NO se escanea (puede legítimamente contener datos técnicos), pero
   *  nunca debe construirse con datos de huésped sin redactar (responsabilidad del
   *  llamador, mismo criterio que `packages/agent-core/src/redact.ts`). */
  captureException(error: unknown, context?: ErrorReportContext): void;

  captureMessage(message: string, level?: ErrorReportLevel, context?: ErrorReportContext): void;
}
