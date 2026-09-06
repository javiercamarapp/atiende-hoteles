/**
 * Adaptador real contra Seam (capa de abstracción de cerraduras -- TTLock, Vostio,
 * Saflok, Onity -- H15-011), ADR-011. Esqueleto honesto: sin cuenta Seam ni cerradura
 * física conectada en esta máquina de desarrollo, se declara `unavailable` -- NUNCA
 * emite/revoca una llave real ni finge hacerlo.
 *
 * [PENDIENTE DE HARDWARE/CREDENCIALES] -- requiere `SEAM_API_KEY` y
 * `SEAM_DEVICE_ID_PREFIX` (identifica qué cerraduras del hotel controla esta cuenta).
 */
import { PortUnavailableError, checkEnvCredentials, type AdapterStatus } from "@atiende-hoteles/mcp-shared";
import {
  DoubleConfirmationRequiredError,
  PmsEvidenceMissingError,
  type LockPort,
  type IssueKeyInput,
  type DigitalKey,
  type RevokeKeyInput,
  type LockConfirmation,
} from "../port.ts";

const REQUIRED_ENV = ["SEAM_API_KEY", "SEAM_DEVICE_ID_PREFIX"] as const;
export const SEAM_API_BASE = "https://connect.getseam.com";

/** Verifica localmente la doble confirmación + evidencia del PMS ANTES de tocar Seam -- fail-closed sin importar hardware. */
function assertDoubleConfirmationAndEvidence(
  confirmations: [LockConfirmation, LockConfirmation],
  pmsEvidence: { checkInPaid: boolean; identityVerified: boolean },
): void {
  const [a, b] = confirmations;
  if (!a.approved || !b.approved) {
    throw new DoubleConfirmationRequiredError("ambas confirmaciones deben ser approved:true");
  }
  if (a.confirmedBy === b.confirmedBy) {
    throw new DoubleConfirmationRequiredError("las 2 confirmaciones deben venir de actores distintos");
  }
  if (!pmsEvidence.checkInPaid || !pmsEvidence.identityVerified) {
    throw new PmsEvidenceMissingError("(ver reservationId en el input original)");
  }
}

export class SeamAdapter implements LockPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "seam", available: true, simulated: false };
    return {
      provider: "seam",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE HARDWARE/CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError(
        "seam",
        `sin cuenta Seam/cerradura física en este entorno (faltan: ${this.credentials.missing.join(", ")})`,
      );
    }
  }

  async issueKey(input: IssueKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey> {
    // Las guardas de doble confirmación + evidencia del PMS se verifican SIEMPRE,
    // incluso antes de comprobar si hay hardware -- nunca se saltan por falta de cuenta Seam.
    assertDoubleConfirmationAndEvidence(confirmations, input.pmsEvidence);
    this.assertAvailable();
    void SEAM_API_BASE;
    throw new PortUnavailableError("seam", "sin cuenta Seam/cerradura física en este entorno");
  }

  async revokeKey(input: RevokeKeyInput, confirmations: [LockConfirmation, LockConfirmation]): Promise<DigitalKey> {
    const [a, b] = confirmations;
    if (!a.approved || !b.approved || a.confirmedBy === b.confirmedBy) {
      throw new DoubleConfirmationRequiredError("ambas confirmaciones deben ser approved:true de actores distintos");
    }
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("seam", "sin cuenta Seam/cerradura física en este entorno");
  }
}
