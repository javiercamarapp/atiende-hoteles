// SIMULADO -- no ejecuta contra hardware real (ADR-011). `simulated: true` en
// `status()`. Permite probar el flujo de check-in digital sin cerradura física,
// rechazando SIEMPRE las peticiones que las pruebas adversariales de REQ-SEG-015 /
// REQ-REC-009 exigen rechazar (doble confirmación incompleta, evidencia del PMS
// incompleta -- el tipo `LockCommandOrigin` ya excluye "voz"/regla de energía en
// tiempo de compilación, ver README.md).
import { randomUUID } from "node:crypto";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";
import {
  DoubleConfirmationRequiredError,
  PmsEvidenceMissingError,
  type LockPort,
  type IssueKeyInput,
  type DigitalKey,
  type RevokeKeyInput,
  type LockConfirmation,
} from "../port.ts";

const KEY_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 noches por default de fixture

function assertDoubleConfirmation(confirmations: [LockConfirmation, LockConfirmation]): void {
  const [a, b] = confirmations;
  if (!a.approved || !b.approved) {
    throw new DoubleConfirmationRequiredError("ambas confirmaciones deben ser approved:true");
  }
  if (a.confirmedBy === b.confirmedBy) {
    throw new DoubleConfirmationRequiredError("las 2 confirmaciones deben venir de actores distintos");
  }
}

export class SimulatedLockAdapter implements LockPort {
  readonly simulated = true as const;
  private readonly keys = new Map<string, DigitalKey>();
  private sequence = 0;

  /** Solo para pruebas: cuántas llaves físicas/digitales han quedado activas realmente. */
  get activeKeyCount(): number {
    return [...this.keys.values()].filter((k) => k.status === "activa").length;
  }

  constructor(private readonly now: () => number = Date.now) {}

  status(): AdapterStatus {
    return { provider: "seam-simulado", available: true, simulated: true };
  }

  async issueKey(input: IssueKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey> {
    assertDoubleConfirmation(confirmations);
    if (!input.pmsEvidence.checkInPaid || !input.pmsEvidence.identityVerified) {
      throw new PmsEvidenceMissingError(input.reservationId);
    }
    this.sequence += 1;
    const issuedAt = this.now();
    const key: DigitalKey = {
      keyId: `KEY-${this.sequence}-${randomUUID().slice(0, 8)}`,
      reservationId: input.reservationId,
      roomId: input.roomId,
      method: input.method,
      status: "activa",
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + KEY_TTL_MS).toISOString(),
    };
    this.keys.set(key.keyId, key);
    return key;
  }

  async revokeKey(input: RevokeKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey> {
    assertDoubleConfirmation(confirmations);
    const key = this.keys.get(input.keyId);
    if (!key) throw new Error(`SimulatedLockAdapter: llave desconocida ${input.keyId}`);
    const revoked: DigitalKey = { ...key, status: "revocada" };
    this.keys.set(input.keyId, revoked);
    return revoked;
  }
}
