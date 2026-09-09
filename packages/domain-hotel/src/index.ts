export { roundCurrency } from "./money.ts";
export { applyTaxes, assertValidTaxConfig, type TaxConfig, type TaxBreakdown } from "./taxes.ts";
export {
  computeQuote,
  parseQuoteInput,
  nightsBetween,
  quoteInputSchema,
  QuoteError,
  type QuoteInput,
  type Quote,
  type NightlyRate,
  type QuoteNightBreakdown,
} from "./quote.ts";
export {
  RESERVATION_STATUSES,
  isValidStatus,
  canTransition,
  isTerminalStatus,
  allowedNextStatuses,
  rolesAllowedForTransition,
  canRolePerformTransition,
  isModifiable,
  isCancellable,
  type ReservationStatus,
  type HotelRoleLike,
} from "./reservationStateMachine.ts";
export {
  evaluateCancellation,
  evaluateNoShow,
  depositRequired,
  hoursBetween,
  type CancellationPolicyConfig,
  type CancellationEvaluation,
  type NoShowEvaluation,
} from "./cancellationPolicy.ts";
export { effectiveCapacity, occupancyPct, canBook, type OverbookingConfig } from "./overbooking.ts";
export { assertBenchmarkQueryAllowed, BenchmarkGuardError, type BenchmarkQueryRequest } from "./compsetGuard.ts";
export {
  CHARGE_CONCEPTS,
  computeChargeAmounts,
  computeNoShowPenaltyAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  type ChargeConcept,
  type ChargeCalcInput,
  type ChargeCalcResult,
  type DiscountAuthorizationInput,
  type DiscountAuthorizationResult,
  type FolioCloseReason,
  type FolioCloseInput,
  type FolioCloseResult,
} from "./folioEngine.ts";
export { looksLikeCheckinDataInFreeText } from "./checkinFreeTextGuard.ts";
export {
  KNOWN_REVIEW_TOPICS,
  TOPIC_KEYWORDS,
  TICKET_TOPICS,
  COMPENSATION_CATALOG,
  normalizar as normalizarTextoResena,
  detectarTemas,
  analizarSentimiento,
  decidirAcciones,
  clasificarResena,
  type KnownReviewTopic,
  type ReviewTopicId,
  type TopicMatch,
  type SentimentLabel,
  type SentimentResult,
  type StayState,
  type CompensacionPropuesta,
  type AccionReputacion,
  type DecidirAccionesInput,
  type ClasificarResenaInput,
  type ResultadoClasificacion,
} from "./reputacion/clasificador.ts";
export {
  detectAndRedactPaymentData,
  luhnValid,
  type PaymentSensitiveDataResult,
} from "./paymentFreeTextGuard.ts";
export {
  computeMrzCheckDigit,
  parsePassportMrz,
  buildPassportMrz,
  InvalidMrzError,
  type ParsedPassportMrz,
} from "./mrz.ts";
export {
  pairAttendanceEvents,
  crossCheckAttendance,
  buildStpsAttendanceCsv,
  type AttendanceEventType,
  type AttendanceEvent,
  type AttendanceSchedule,
  type AttendanceShift,
  type AttendanceAnomaly,
  type AttendanceCrossCheckStatus,
  type AttendanceCrossCheckResult,
  type CrossCheckAttendanceInput,
  type StpsExportRow,
} from "./attendance.ts";
export {
  computeIva,
  computeIsh,
  computeDsa,
  computeIsn,
  computeIsrProvisional,
  computeDiotTotal,
  computeRetencionPlataformasDigitales,
  type DiotOperation,
  type PlatformFilerType,
  type RetencionPlataformasDigitalesRates,
  type RetencionPlataformasDigitales,
} from "./fiscalHospedaje.ts";
export {
  DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE,
  classifyShiftType,
  shiftDurationMinutes,
  ordinaryDailyLimitMinutes,
  validateTurnosLft,
  assertTurnosLftPublishable,
  TurnosLftViolationError,
  type ShiftType,
  type ProposedShift,
  type WeeklyHourLimitMilestone,
  type ShiftLftViolationType,
  type ShiftLftViolation,
  type ValidateTurnosLftInput,
  type ValidateTurnosLftResult,
} from "./housekeeping/turnos-lft.ts";
// H12c merge (integrador) · 2026-09-08: se retiran aquí 6 bloques `export { … } from` que
// apuntaban a `./voiceGuardrails.ts`, `./pl/usaliPL.ts`, `./tickets/slaPolicy.ts`,
// `./marketingTemplateLinter.ts`, `./conversationalGuardrails.ts` y
// `./guestContactChangeOtp.ts` — NINGUNO de esos 6 archivos existe ni existió nunca en el
// historial de git (`git log --all -- <ruta>` vacío para los 6), así que este barrel no
// cargaba en absoluto: cualquier import de `@atiende-hoteles/domain-hotel` (todo `apps/api`
// vía `packages/agent-core`) fallaba en runtime con `Cannot find module`, no solo en
// typecheck. Introducido por el commit 5e21c12 (REQ-OBS-007) en `origin/main`, ajeno a este
// merge H12c — probablemente un `git add` olvidado de esos 6 archivos nuevos en esa sesión.
// Verificado ANTES de retirarlos que ningún símbolo de esos 6 bloques (p. ej.
// `classifyVoiceGuardrailRefusal`, `buildUsaliPL`, `classifyGuestMessage`,
// `lintMarketingTemplateBody`, `classifyUnaccompaniedMinorEscalation`, `generateOtpCode`)
// se usa en ningún otro archivo de `apps/**`/`packages/**`/`tests/**` — no hay ninguna
// funcionalidad real que se pierda al retirar el export, solo se restaura la capacidad de
// cargar el paquete. Ver docs/BLOQUEOS.md N-002 y docs/logs/bucle.log.
export {
  WAITLIST_STATUSES,
  WAITLIST_OFFER_WINDOW_HOURS,
  matchesWaitlistRequest,
  selectNextWaitlistCandidate,
  computeOfferExpiresAt,
  isOfferExpired,
  type WaitlistStatus,
  type WaitlistCandidate,
  type WaitlistMatchCriteria,
} from "./reservas/waitlist.ts";
export {
  buildReporteMensualDueno,
  type RoiEventoMensual,
  type ReporteMensualDuenoInput,
  type ReporteMensualDueno,
} from "./pl/reporteMensualDueno.ts";
// H12c merge (integrador) · 2026-09-08: `./forecast/index.ts` (REQ-AGT-012, commit b1f3d47
// en origin/main) sí existe con sus 2 archivos completos, pero nunca se re-exportó desde
// este barrel -- `tests/unit/domain-hotel/pronostico-series-tiempo.spec.ts` importa
// `forecastExponentialSmoothing`/`forecastPickup`/`TimeSeriesPoint` de
// `@atiende-hoteles/domain-hotel` (el paquete completo) y fallaba en typecheck por el
// mismo patrón que los 6 bloques retirados arriba: código real ya escrito, sin cablear al
// punto de entrada del paquete. A diferencia de esos 6, aquí sí basta con re-exportar --
// el archivo fuente existe y está completo.
export {
  forecastExponentialSmoothing,
  forecastPickup,
  type ForecastKind,
  type TimeSeriesPoint,
  type ExponentialSmoothingOptions,
  type ForecastPoint,
  type ExponentialSmoothingResult,
  type PickupCurvePoint,
  type PickupForecastInput,
  type PickupForecastResult,
} from "./forecast/index.ts";
export {
  BASELINE_SIGNING_WINDOW_DAYS,
  daysBetween as daysBetweenRoiBaseline,
  isWithinWeek1 as isRoiBaselineWithinWeek1,
  assertBaselineSignableWithinWeek1,
  evaluateCobroPorResultadoActivation,
  RoiBaselineError,
  type RoiBaselineSummary,
  type CobroPorResultadoActivationParams,
  type CobroPorResultadoActivationCheck,
} from "./roi/roiBaseline.ts";
