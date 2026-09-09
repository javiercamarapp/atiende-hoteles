// REQ-REC-009 (P0, SEG) + REQ-SEG-015 (P0) -- prueba adversarial compartida (ADR-011,
// GOB-044): "emisión/revocación de llave digital exige autenticación fuerte por canal
// autenticado + evento del PMS (check-in pagado + identidad verificada); intento de
// emisión por voz o por regla automática de energía → rechazado (0 llaves emitidas en
// el intento adversarial)". Referenciada por `docs/ACEPTACION.md` (REQ-REC-009,
// REQ-SEG-015) y `docs/TRAZABILIDAD.md`.
//
// A diferencia de `tests/unit/mcp-servers/locks/contract.spec.ts` (caso feliz + reglas
// básicas) y `tests/unit/mcp-servers/architecture/lock-isolation.spec.ts` (análisis
// estático de imports), este archivo ataca el puerto como lo haría un adversario real:
// forzando un `origin` fuera del tipo (`as unknown as ...`, exactamente lo que un
// webhook/JSON crudo sin pasar por el compilador de TypeScript podría intentar),
// mezclando canales de voz con reglas automáticas de energía, y confirmando en cada
// caso que 0 llaves quedan activas.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SimulatedLockAdapter,
  SeamAdapter,
  DoubleConfirmationRequiredError,
  PmsEvidenceMissingError,
  InvalidLockCommandError,
  lockCommandOrigins,
  type IssueKeyInput,
  type RevokeKeyInput,
  type LockConfirmation,
} from "@atiende-hoteles/mcp-locks";
import { AGENT_DEFINITIONS } from "@atiende-hoteles/agent-core";
import { checkPmsMirrorSoloLectura } from "../../scripts/checks/pms-mirror-solo-lectura.ts";

function validEvidence() {
  return { checkInPaid: true, identityVerified: true, externalReservationId: "CB-RES-9001" };
}

function issueInput(overrides: Partial<IssueKeyInput> = {}): IssueKeyInput {
  return {
    reservationId: "res-adversarial-1",
    roomId: "205",
    method: "ble",
    origin: "guest_app",
    pmsEvidence: validEvidence(),
    ...overrides,
  };
}

const confirmFrontDeskA: LockConfirmation = { approved: true, confirmedBy: "recepcion-1", decisionId: "adv-d1" };
const confirmFrontDeskB: LockConfirmation = { approved: true, confirmedBy: "recepcion-2", decisionId: "adv-d2" };
const validConfirmations: [LockConfirmation, LockConfirmation] = [confirmFrontDeskA, confirmFrontDeskB];

// Cadenas de origen que un intento de bypass por voz o por regla automática de energía
// intentaría colar -- ninguna es un `LockCommandOrigin` válido.
const ADVERSARIAL_ORIGINS = [
  "voz",
  "voice",
  "regla_automatica_energia",
  "regla_automatica",
  "ivr",
  "telefono",
  "energy_rule",
] as const;

describe("REQ-SEG-015/REQ-REC-009 -- intento de emitir/abrir una llave digital por VOZ debe fallar SIEMPRE", () => {
  it.each(ADVERSARIAL_ORIGINS)(
    "SimulatedLockAdapter.issueKey rechaza origin=%s incluso con doble confirmación y evidencia del PMS válidas",
    async (origenAdversarial) => {
      const adapter = new SimulatedLockAdapter();
      // Un origin fuera del tipo NO compila con TypeScript -- eso ya es la primera
      // defensa. Esta prueba ataca la SEGUNDA defensa (runtime), simulando exactamente
      // lo que un llamador que no pasa por el compilador (webhook, JSON.parse de un
      // payload externo, un cliente en JS puro) podría intentar colar.
      const input = issueInput({ origin: origenAdversarial as unknown as IssueKeyInput["origin"] });

      await expect(adapter.issueKey(input, validConfirmations)).rejects.toBeInstanceOf(InvalidLockCommandError);
      expect(adapter.activeKeyCount).toBe(0);
    },
  );

  it.each(ADVERSARIAL_ORIGINS)(
    "SeamAdapter (real, sin hardware) también rechaza origin=%s -- la validación de runtime es del PUERTO, no del adaptador simulado",
    async (origenAdversarial) => {
      const adapter = new SeamAdapter();
      const input = issueInput({ origin: origenAdversarial as unknown as IssueKeyInput["origin"] });

      // Rechazado por forma inválida ANTES de siquiera preguntar si hay cuenta Seam --
      // nunca se llega a "sin hardware" cuando el comando ya es ilegítimo.
      await expect(adapter.issueKey(input, validConfirmations)).rejects.toBeInstanceOf(InvalidLockCommandError);
    },
  );

  it("revokeKey también rechaza origin=voz -- revocar por voz no es 'menos peligroso' que emitir por voz", async () => {
    const adapter = new SimulatedLockAdapter();
    const key = await adapter.issueKey(issueInput(), validConfirmations);

    const revokeAttempt: RevokeKeyInput = {
      keyId: key.keyId,
      origin: "voz" as unknown as RevokeKeyInput["origin"],
    };
    await expect(adapter.revokeKey(revokeAttempt, validConfirmations)).rejects.toBeInstanceOf(InvalidLockCommandError);
    // La llave emitida legítimamente sigue activa -- el intento de voz no la tocó.
    expect(adapter.activeKeyCount).toBe(1);
  });

  it("un origin de voz NO puede colarse ni combinándolo con evidencia del PMS falsificada/incompleta -- se rechaza por forma antes de llegar a esa guarda", async () => {
    const adapter = new SimulatedLockAdapter();
    const input = issueInput({
      origin: "voz" as unknown as IssueKeyInput["origin"],
      pmsEvidence: { checkInPaid: false, identityVerified: false, externalReservationId: "CB-RES-FAKE" },
    });
    await expect(adapter.issueKey(input, validConfirmations)).rejects.toBeInstanceOf(InvalidLockCommandError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("TypeScript en sí mismo ya rechaza 'voz'/'regla_automatica_energia' como LockCommandOrigin -- documentado, no solo runtime", () => {
    expect(lockCommandOrigins).toEqual(["guest_app", "front_desk_staff"]);
    // @ts-expect-error -- "voz" no es un LockCommandOrigin válido: ni siquiera compila
    // sin el `as unknown as` usado deliberadamente en las pruebas de arriba.
    const invalido: IssueKeyInput["origin"] = "voz";
    expect(invalido).toBeDefined();
  });
});

describe("REQ-REC-009 -- límites reales exigidos ANTES de emitir (autenticación fuerte + evento del PMS)", () => {
  it("0 llaves emitidas cuando falta evidencia de check-in pagado, aunque el origen y la doble confirmación sean legítimos", async () => {
    const adapter = new SimulatedLockAdapter();
    const input = issueInput({ pmsEvidence: { ...validEvidence(), checkInPaid: false } });
    await expect(adapter.issueKey(input, validConfirmations)).rejects.toBeInstanceOf(PmsEvidenceMissingError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("0 llaves emitidas cuando falta evidencia de identidad verificada", async () => {
    const adapter = new SimulatedLockAdapter();
    const input = issueInput({ pmsEvidence: { ...validEvidence(), identityVerified: false } });
    await expect(adapter.issueKey(input, validConfirmations)).rejects.toBeInstanceOf(PmsEvidenceMissingError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("0 llaves emitidas con una sola confirmación humana (autenticación fuerte = 2 actores, no 1)", async () => {
    const adapter = new SimulatedLockAdapter();
    const soloUna: [LockConfirmation, LockConfirmation] = [
      confirmFrontDeskA,
      { approved: false, confirmedBy: "recepcion-2", decisionId: "adv-d3" },
    ];
    await expect(adapter.issueKey(issueInput(), soloUna)).rejects.toBeInstanceOf(DoubleConfirmationRequiredError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("0 llaves emitidas cuando las 2 'confirmaciones' vienen del mismo actor (no es autenticación fuerte, es la misma persona 2 veces)", async () => {
    const adapter = new SimulatedLockAdapter();
    const mismoActor: [LockConfirmation, LockConfirmation] = [
      confirmFrontDeskA,
      { approved: true, confirmedBy: confirmFrontDeskA.confirmedBy, decisionId: "adv-d4" },
    ];
    await expect(adapter.issueKey(issueInput(), mismoActor)).rejects.toBeInstanceOf(DoubleConfirmationRequiredError);
    expect(adapter.activeKeyCount).toBe(0);
  });

  it("emite la llave SOLO cuando las 3 condiciones (origen permitido + doble confirmación + evidencia del PMS) se cumplen -- caso feliz de control", async () => {
    const adapter = new SimulatedLockAdapter();
    const key = await adapter.issueKey(issueInput(), validConfirmations);
    expect(key.status).toBe("activa");
    expect(adapter.activeKeyCount).toBe(1);
  });

  it("un lote mixto de intentos adversariales (voz, energía, confirmación única, PMS incompleto) deja 0 llaves activas al final", async () => {
    const adapter = new SimulatedLockAdapter();
    const intentos = [
      () => adapter.issueKey(issueInput({ origin: "voz" as unknown as IssueKeyInput["origin"] }), validConfirmations),
      () =>
        adapter.issueKey(
          issueInput({ origin: "regla_automatica_energia" as unknown as IssueKeyInput["origin"] }),
          validConfirmations,
        ),
      () =>
        adapter.issueKey(issueInput(), [
          confirmFrontDeskA,
          { approved: false, confirmedBy: "recepcion-2", decisionId: "x" },
        ]),
      () => adapter.issueKey(issueInput({ pmsEvidence: { ...validEvidence(), checkInPaid: false } }), validConfirmations),
    ];
    for (const intento of intentos) {
      await expect(intento()).rejects.toThrow();
    }
    expect(adapter.activeKeyCount).toBe(0);
  });
});

describe("REQ-SEG-015 -- ningún agente/canal accionable por voz tiene una tool que emita/revoque llaves", () => {
  it("el catálogo de agentes (agent-core) no declara ninguna tool de llave/cerradura para el canal voz/WhatsApp/web", () => {
    const patronLlave = /llave|cerradura|lock|key/i;
    for (const agente of Object.values(AGENT_DEFINITIONS)) {
      const toolsSospechosas = agente.toolNames.filter((nombre) => patronLlave.test(nombre));
      expect(toolsSospechosas, `agente "${agente.name}" no debe tener tools de llave/cerradura`).toEqual([]);
    }
  });

  it("análisis estático (mismo check que CI, scripts/checks/pms-mirror-solo-lectura.ts) confirma 0 referencias a LockPort/issueKey/revokeKey fuera de packages/mcp-servers/locks en todo apps/**, packages/**", () => {
    const violaciones = checkPmsMirrorSoloLectura().filter((v) => v.category === "invocacion-directa-de-cerraduras");
    expect(violaciones).toEqual([]);
  });

  it("el paquete de agent-core (dueño de la ruta de voz/canal) no importa @atiende-hoteles/mcp-locks", () => {
    const agentCoreProviderPath = fileURLToPath(new URL("../../packages/agent-core/src/agents.ts", import.meta.url));
    const contenido = readFileSync(agentCoreProviderPath, "utf8");
    expect(contenido).not.toMatch(/mcp-locks|LockPort|issueKey|revokeKey/);
  });
});
