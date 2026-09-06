// Prueba de contrato de LockPort (ADR-011, REQ-RES-017/REC-009/SEG-015): emisión/
// revocación de llave con doble confirmación + evidencia del PMS. "Ninguna acción física
// (llave) ocurre sin las dos aprobaciones" se verifica explícitamente aquí.
import { describe, expect, it } from "vitest";
import {
  SimulatedLockAdapter,
  SeamAdapter,
  DoubleConfirmationRequiredError,
  PmsEvidenceMissingError,
  type IssueKeyInput,
  type LockConfirmation,
} from "@atiende-hoteles/mcp-locks";
import { PortUnavailableError } from "@atiende-hoteles/mcp-shared";

function validEvidence() {
  return { checkInPaid: true, identityVerified: true, externalReservationId: "CB-RES-1001" };
}

function issueInput(overrides: Partial<IssueKeyInput> = {}): IssueKeyInput {
  return {
    reservationId: "res-1",
    roomId: "101",
    method: "ble",
    origin: "guest_app",
    pmsEvidence: validEvidence(),
    ...overrides,
  };
}

const confirmA: LockConfirmation = { approved: true, confirmedBy: "recepcion-1", decisionId: "d1" };
const confirmB: LockConfirmation = { approved: true, confirmedBy: "recepcion-2", decisionId: "d2" };

describe("SimulatedLockAdapter.issueKey -- doble confirmación obligatoria", () => {
  it("emite la llave cuando las 2 condiciones (doble confirmación + evidencia del PMS) se cumplen", async () => {
    const adapter = new SimulatedLockAdapter();
    const key = await adapter.issueKey(issueInput(), [confirmA, confirmB]);
    expect(key.status).toBe("activa");
    expect(adapter.activeKeyCount).toBe(1);
  });

  it("rechaza con una sola confirmación 'approved' y otra 'no aprobada'", async () => {
    const adapter = new SimulatedLockAdapter();
    const onlyOneApproved: LockConfirmation = { approved: false, confirmedBy: "recepcion-2", decisionId: "d2" };
    await expect(adapter.issueKey(issueInput(), [confirmA, onlyOneApproved])).rejects.toBeInstanceOf(
      DoubleConfirmationRequiredError,
    );
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("rechaza si las 2 confirmaciones vienen del MISMO actor (no es doble confirmación real)", async () => {
    const adapter = new SimulatedLockAdapter();
    const sameActorTwice: LockConfirmation = { approved: true, confirmedBy: "recepcion-1", decisionId: "d2" };
    await expect(adapter.issueKey(issueInput(), [confirmA, sameActorTwice])).rejects.toBeInstanceOf(
      DoubleConfirmationRequiredError,
    );
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("rechaza si el PMS no confirma check-in pagado, aunque la doble confirmación esté completa", async () => {
    const adapter = new SimulatedLockAdapter();
    const input = issueInput({ pmsEvidence: { ...validEvidence(), checkInPaid: false } });
    await expect(adapter.issueKey(input, [confirmA, confirmB])).rejects.toBeInstanceOf(PmsEvidenceMissingError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("rechaza si la identidad no está verificada, aunque el check-in esté pagado", async () => {
    const adapter = new SimulatedLockAdapter();
    const input = issueInput({ pmsEvidence: { ...validEvidence(), identityVerified: false } });
    await expect(adapter.issueKey(input, [confirmA, confirmB])).rejects.toBeInstanceOf(PmsEvidenceMissingError);
    expect(adapter.activeKeyCount).toBe(0);
  });
});

describe("SimulatedLockAdapter.revokeKey -- misma exigencia de doble confirmación", () => {
  it("revoca una llave activa con doble confirmación completa", async () => {
    const adapter = new SimulatedLockAdapter();
    const key = await adapter.issueKey(issueInput(), [confirmA, confirmB]);
    const revoked = await adapter.revokeKey({ keyId: key.keyId, origin: "front_desk_staff" }, [confirmA, confirmB]);
    expect(revoked.status).toBe("revocada");
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("rechaza revocar con una sola confirmación", async () => {
    const adapter = new SimulatedLockAdapter();
    const key = await adapter.issueKey(issueInput(), [confirmA, confirmB]);
    const notApproved: LockConfirmation = { approved: false, confirmedBy: "recepcion-2", decisionId: "d3" };
    await expect(
      adapter.revokeKey({ keyId: key.keyId, origin: "front_desk_staff" }, [confirmA, notApproved]),
    ).rejects.toBeInstanceOf(DoubleConfirmationRequiredError);
    expect(adapter.activeKeyCount).toBe(1); // sigue activa, no se revocó a medias
  });
});

describe("LockCommandOrigin -- 'voz' y 'regla_automatica_energia' no son orígenes válidos", () => {
  it("el tipo LockCommandOrigin solo admite guest_app|front_desk_staff (verificación de tipos, no runtime)", () => {
    const origins: Array<IssueKeyInput["origin"]> = ["guest_app", "front_desk_staff"];
    expect(origins).toHaveLength(2);
    // @ts-expect-error -- "voz" no es un LockCommandOrigin válido: ni siquiera compila.
    const invalido: IssueKeyInput["origin"] = "voz";
    expect(invalido).toBeDefined();
  });
});

describe("SeamAdapter (real) sin credenciales/hardware -- declaración honesta", () => {
  const adapter = new SeamAdapter();

  it("status() reporta [PENDIENTE DE HARDWARE/CREDENCIALES]", () => {
    if (adapter.status().available) return;
    expect(adapter.status().reason).toMatch(/PENDIENTE DE HARDWARE\/CREDENCIALES/);
  });

  it("las guardas de doble confirmación se verifican ANTES que la disponibilidad de Seam", async () => {
    const onlyOneApproved: LockConfirmation = { approved: false, confirmedBy: "recepcion-2", decisionId: "d2" };
    await expect(adapter.issueKey(issueInput(), [confirmA, onlyOneApproved])).rejects.toBeInstanceOf(
      DoubleConfirmationRequiredError,
    );
  });

  it("con guardas satisfechas pero sin cuenta Seam, lanza PortUnavailableError (nunca emite una llave real)", async () => {
    if (adapter.status().available) return;
    await expect(adapter.issueKey(issueInput(), [confirmA, confirmB])).rejects.toBeInstanceOf(PortUnavailableError);
  });
});
