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
  ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY,
  assertRoomChargeIdentityVerified,
  type ChargeConcept,
  type ChargeCalcInput,
  type ChargeCalcResult,
  type DiscountAuthorizationInput,
  type DiscountAuthorizationResult,
  type FolioCloseReason,
  type FolioCloseInput,
  type FolioCloseResult,
  type RoomChargeIdentityClaim,
  type RoomChargeIdentityVerificationInput,
  type RoomChargeIdentityVerificationResult,
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
// Merge de reconciliación (2026-09-08): la sesión H12c había retirado estos 6 bloques
// `export { … } from` (`./voiceGuardrails.ts`, `./pl/usaliPL.ts`, `./tickets/slaPolicy.ts`,
// `./marketingTemplateLinter.ts`, `./conversationalGuardrails.ts`,
// `./guestContactChangeOtp.ts`) porque en SU rama esos 6 archivos nunca existieron
// (introducidos únicamente en la rama local de ronda 4/REQ-HUE-014/REQ-HUE-021/REQ-BO-010/
// REQ-HUE-023, sin pushear todavía en ese momento). Los 6 archivos SÍ existen completos con
// pruebas propias (tests/unit/domain-hotel/{voice-guardrails,usali-pl,ticket-sla-policy,
// conversational-guardrails,guest-contact-change-otp}.spec.ts) -- se restauran los exports
// tras confirmar con `npm run typecheck`/`npx vitest run` que compilan y pasan de verdad.
export {
  classifyVoiceGuardrailRefusal,
  looksLikeCardPaymentByVoice,
  looksLikeOffPmsRateRequest,
  looksLikeRoomOrPresenceDisclosureRequest,
  looksLikeKeyIssuanceByVoiceRequest,
  type VoiceGuardrailReason,
  type VoiceGuardrailRefusal,
} from "./voiceGuardrails.ts";
export {
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
  REVENUE_FORECAST_HORIZON_DAYS,
  CASH_PROJECTION_WEEKS,
  buildDepartmentalStatements,
  buildUsaliPL,
  forecastDailyRevenue90Days,
  computeDynamicBreakeven,
  buildCashFlow13Weeks,
  buildOwnersReport,
  type UsaliRevenueDepartment,
  type UsaliUndistributedDepartment,
  type UsaliExpenseCategory,
  type DepartmentRevenueRow,
  type DepartmentExpenseRow,
  type DepartmentStatement,
  type UndistributedRow,
  type UsaliPL,
  type BuildUsaliPLInput,
  type DynamicBreakevenInput,
  type DynamicBreakevenResult,
  type CashWeekInput,
  type CashWeekProjection,
  type OwnersReportKpis,
  type ForecastSummary,
  type CashSummary,
  type OwnersReportInput,
  type OwnersReport,
} from "./pl/usaliPL.ts";
export {
  GUEST_TICKET_DEPARTMENTS,
  GUEST_TICKET_PRIORITIES,
  DEFAULT_SLA_MINUTES_BY_PRIORITY,
  classifyGuestMessage,
  resolveSlaMinutes,
  computeSlaDueAt,
  isSlaOverdue,
  type GuestTicketDepartment,
  type GuestTicketPriority,
  type GuestMessageClassification,
} from "./tickets/slaPolicy.ts";
export {
  lintMarketingTemplateBody,
  type MarketingTemplateLintResult,
} from "./marketingTemplateLinter.ts";
export {
  classifyUnaccompaniedMinorEscalation,
  containsDiscriminatoryContent,
  type UnaccompaniedMinorSignal,
  type DiscriminatoryCategory,
  type DiscriminatoryContentResult,
} from "./conversationalGuardrails.ts";
export {
  OTP_CODE_LENGTH,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  generateOtpCode,
  evaluateOtpConfirmation,
  type OtpConfirmationOutcome,
  type EvaluateOtpConfirmationInput,
  type EvaluateOtpConfirmationResult,
} from "./guestContactChangeOtp.ts";
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
export {
  DIRECT_CHANNEL,
  isDirectChannel,
  resolveCommissionPct,
  assertValidChannelCommissionConfig,
  buildChannelAttributionReport,
  type ChannelCommissionConfig,
  type ReservationAttributionInput,
  type ChannelAttributionSummary,
  type ChannelAttributionReport,
} from "./reservas/atribucionCanal.ts";
export {
  LOYALTY_MEMBER_STATUSES,
  isActiveLoyaltyMember,
  assertValidLoyaltyDiscountPct,
  applyLoyaltyBenefit,
  type LoyaltyMemberStatus,
  type LoyaltyBenefitInput,
  type LoyaltyBenefitResult,
} from "./reservas/clubSegundoViaje.ts";
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
export {
  looksLikeAllergyDeclaration,
  resolveAllergyDeclared,
  canAssureDishIsSafe,
  AllergySafetyAssuranceBlockedError,
  assertCanAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  type AllergyDeclaredVia,
  type ResolveAllergyDeclaredInput,
  type ResolveAllergyDeclaredResult,
  type FnbOrderSafetyState,
} from "./fnbAllergyGuard.ts";
export {
  FRAUD_PATTERNS,
  recipientRolesForPattern,
  detectDiscountOutsidePolicy,
  detectFolioReopenedAfterAudit,
  detectUnpostedFnbCharge,
  detectRefundToDifferentCard,
  type FraudPattern,
  type FraudFinding,
  type DiscountPolicyInput,
  type FolioReopenInput,
  type FnbPosReconciliationInput,
  type RefundCardMismatchInput,
} from "./fraude/deteccion.ts";
export {
  PARITY_MODES,
  ParityGuardError,
  assertValidParityChannelConfig,
  assertValidParityGuardConfig,
  computeParityFloor,
  evaluateParityGuard,
  type ParityMode,
  type ParityChannelConfig,
  type ParityGuardConfig,
  type ParityChannelViolation,
  type ParityCheckResult,
} from "./revenue/parity-guard.ts";
export {
  REVENUE_GATE_STATES,
  MIN_SHADOW_DAYS,
  PROPONE_VARIATION_PCT_MIN,
  PROPONE_VARIATION_PCT_MAX,
  RevenueGateError,
  daysElapsed,
  hasMetMinimumShadowPeriod,
  isPromotion,
  isDemotion,
  evaluateGateTransition,
  assertValidProponeVariationPct,
  isPriceChangeWithinProponeLimit,
  evaluateRevenueProposal,
  type RevenueGateState,
  type PromotionContext,
  type GateTransitionEvaluation,
  type RevenueProposalCheck,
} from "./revenue/revenueEngineGate.ts";
export {
  buildWalkForwardWindows,
  evaluateWalkForwardBacktest,
  type CounterfactualMethod,
  type DailyPricingRecord,
  type WalkForwardWindowSpec,
  type WalkForwardWindow,
  type WindowEvaluation,
  type WalkForwardBacktestInput,
  type WalkForwardBacktestResult,
} from "./revenue/walkForwardBacktest.ts";
export {
  PriceExplanationError,
  assertValidPriceRecommendationInput,
  explainPriceRecommendation,
  type PriceFactorKind,
  type PickupFactor,
  type CompsetFactor,
  type EventoFactor,
  type TipoCambioFactor,
  type PriceFactor,
  type PriceRecommendationInput,
  type ExplainedFactor,
  type PriceDirection,
  type PriceRecommendationExplanation,
} from "./revenue/priceRecommendationExplainer.ts";
  DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE,
  CONVERSATION_AUDIT_CATEGORIES,
  ConversationAuditError,
  resolveIsoWeekStart,
  resolveAuditWindow,
  selectWeeklyAuditSample,
  assertValidAuditReview,
  type ConversationAuditCategory,
  type AuditReviewInput,
  type AuditReviewValidated,
} from "./qa/conversationAudit.ts";
export {
  CONSENT_JURISDICTIONS,
  consentKindSchema,
  consentChannelSchema,
  resolveConsentJurisdiction,
  annotateConsentLedger,
  filterConsentLedger,
  summarizeConsentLedger,
  type ConsentJurisdiction,
  type ConsentKind,
  type ConsentChannel,
  type ConsentLedgerRow,
  type ConsentLedgerEntry,
  type ConsentLedgerSummaryBucket,
} from "./consentLedger.ts";
