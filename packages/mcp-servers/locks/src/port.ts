/**
 * `LockPort` -- emisión/revocación de llave digital vía capa de abstracción tipo Seam
 * (nunca un fabricante directo), ADR-011. Cubre REQ-RES-017, REQ-REC-009 (P0, SEG),
 * REQ-SEG-015 (P0), REQ-INT-008. Ver docs/ARQUITECTURA.md ADR-011.
 *
 * Garantía estructural (GOB-044): este puerto es **estructuralmente inalcanzable** desde
 * `@atiende-hoteles/mcp-energy`, desde un motor de reglas automáticas o desde el canal
 * de voz -- ninguno de esos módulos importa este paquete (verificado por análisis
 * estático en `tests/unit/mcp-servers/architecture/`). Además, en tiempo de ejecución,
 * `origin` excluye explícitamente `"voz"` y `"regla_automatica_energia"` del tipo
 * `LockCommandOrigin` -- ni siquiera compila una llamada que intente ese origen.
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Origen permitido del comando. Deliberadamente NO incluye "voz" ni
// "regla_automatica_energia" -- REQ-REC-009 exige que la emisión/revocación de llaves
// nunca se gestione por esos canales. Si en el futuro alguien necesita agregar un origen
// nuevo, tiene que pasar por este archivo (y por la prueba adversarial que lo cubre).
// ---------------------------------------------------------------------------
export const lockCommandOrigins = ["guest_app", "front_desk_staff"] as const;
export const LockCommandOrigin = z.enum(lockCommandOrigins);
export type LockCommandOrigin = z.infer<typeof LockCommandOrigin>;

export const lockKeyStatuses = ["activa", "revocada", "expirada"] as const;
export const LockKeyStatus = z.enum(lockKeyStatuses);
export type LockKeyStatus = z.infer<typeof LockKeyStatus>;

export const lockKeyMethods = ["pin", "ble", "codigo_kiosco"] as const;
export const LockKeyMethod = z.enum(lockKeyMethods);
export type LockKeyMethod = z.infer<typeof LockKeyMethod>;

/**
 * Evidencia de autenticación fuerte + evento del PMS exigida por REQ-REC-009: la llave
 * NUNCA se emite solo porque alguien la pidió por el canal -- tiene que venir acompañada
 * del evento real del PMS.
 */
export const PmsCheckInEvidence = z.object({
  checkInPaid: z.boolean(),
  identityVerified: z.boolean(),
  externalReservationId: z.string().min(1),
});
export type PmsCheckInEvidence = z.infer<typeof PmsCheckInEvidence>;

/** Una única confirmación humana (mismo shape que `ApprovalDecision` de `@atiende-hoteles/mcp-energy`). */
export const LockConfirmation = z.object({
  approved: z.boolean(),
  confirmedBy: z.string().min(1),
  decisionId: z.string().min(1),
});
export type LockConfirmation = z.infer<typeof LockConfirmation>;

export const IssueKeyInput = z.object({
  reservationId: z.string().min(1),
  roomId: z.string().min(1),
  method: LockKeyMethod,
  origin: LockCommandOrigin,
  pmsEvidence: PmsCheckInEvidence,
});
export type IssueKeyInput = z.infer<typeof IssueKeyInput>;

export const DigitalKey = z.object({
  keyId: z.string().min(1),
  reservationId: z.string().min(1),
  roomId: z.string().min(1),
  method: LockKeyMethod,
  status: LockKeyStatus,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type DigitalKey = z.infer<typeof DigitalKey>;

export const RevokeKeyInput = z.object({
  keyId: z.string().min(1),
  origin: LockCommandOrigin,
});
export type RevokeKeyInput = z.infer<typeof RevokeKeyInput>;

// ---------------------------------------------------------------------------
// Errores -- todos fail-closed: ninguno de estos caminos emite/revoca una llave.
// ---------------------------------------------------------------------------

/** Faltan 2 confirmaciones de actores DISTINTOS (doble confirmación, mismo criterio que dinero en agent-core). */
export class DoubleConfirmationRequiredError extends Error {
  readonly code = "double_confirmation_required";
  constructor(readonly detail: string) {
    super(`emisión/revocación de llave requiere doble confirmación de actores distintos: ${detail}`);
    this.name = "DoubleConfirmationRequiredError";
  }
}

/** El evento del PMS no confirma check-in pagado + identidad verificada. */
export class PmsEvidenceMissingError extends Error {
  readonly code = "pms_evidence_missing";
  constructor(readonly reservationId: string) {
    super(`reserva ${reservationId}: falta check-in pagado y/o identidad verificada en el PMS`);
    this.name = "PmsEvidenceMissingError";
  }
}

/**
 * REQ-SEG-015/REQ-REC-009 -- rechazo fail-closed cuando `input`/`confirmations` no
 * cumplen el contrato exacto de este puerto en RUNTIME, no solo en tiempo de
 * compilación. `LockCommandOrigin` excluye "voz"/"regla_automatica_energia" del tipo,
 * pero un tipo de TypeScript no protege contra un llamador que no pase por el
 * compilador (JSON crudo de un webhook, un `as any`, un caller en JS puro) -- sin esta
 * validación, ese llamador podría colar un origin arbitrario porque ni
 * `SimulatedLockAdapter` ni `SeamAdapter` reconstruían el schema en runtime. Cualquier
 * `input`/`confirmations` que no valide contra el schema Zod se rechaza aquí, ANTES de
 * revisar doble confirmación o evidencia del PMS -- 0 llaves emitidas/revocadas cuando
 * la forma del comando es inválida, sin importar qué tan "cerca" esté de ser válida.
 */
export class InvalidLockCommandError extends Error {
  readonly code = "invalid_lock_command";
  constructor(readonly detail: string) {
    super(`comando de llave inválido, rechazado (fail-closed): ${detail}`);
    this.name = "InvalidLockCommandError";
  }
}

const ConfirmationPair = z.tuple([LockConfirmation, LockConfirmation]);

/** Usado por los adaptadores (`SimulatedLockAdapter`, `SeamAdapter`) como PRIMERA línea
 *  de `issueKey`: valida `input` en runtime contra `IssueKeyInput` (incluyendo que
 *  `origin` sea `"guest_app" | "front_desk_staff"`, nunca `"voz"` ni
 *  `"regla_automatica_energia"`) y `confirmations` contra el par exigido. */
export function assertValidIssueKeyCommand(
  input: unknown,
  confirmations: unknown,
): asserts input is IssueKeyInput {
  const parsedInput = IssueKeyInput.safeParse(input);
  if (!parsedInput.success) {
    throw new InvalidLockCommandError(`issueKey.input -- ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const parsedConfirmations = ConfirmationPair.safeParse(confirmations);
  if (!parsedConfirmations.success) {
    throw new InvalidLockCommandError(`issueKey.confirmations -- ${parsedConfirmations.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
}

/** Misma validación que `assertValidIssueKeyCommand`, para `revokeKey`. */
export function assertValidRevokeKeyCommand(
  input: unknown,
  confirmations: unknown,
): asserts input is RevokeKeyInput {
  const parsedInput = RevokeKeyInput.safeParse(input);
  if (!parsedInput.success) {
    throw new InvalidLockCommandError(`revokeKey.input -- ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const parsedConfirmations = ConfirmationPair.safeParse(confirmations);
  if (!parsedConfirmations.success) {
    throw new InvalidLockCommandError(`revokeKey.confirmations -- ${parsedConfirmations.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface LockPort {
  status(): AdapterStatus;

  /**
   * Emite una llave digital. Exige EXACTAMENTE 2 `confirmations` de `confirmedBy`
   * distintos, ambas `approved: true`, y `pmsEvidence.checkInPaid && identityVerified`.
   * Fail-closed: cualquier combinación incompleta lanza `DoubleConfirmationRequiredError`
   * o `PmsEvidenceMissingError` -- nunca emite "por si acaso".
   */
  issueKey(input: IssueKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey>;

  /** Misma exigencia de doble confirmación que `issueKey`. */
  revokeKey(input: RevokeKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey>;
}
