// SIMULADO -- no ejecuta contra hardware real (ADR-011). Etiquetado explícito en el
// nombre de la clase y en `status().simulated === true`. Reproduce lecturas de medidor
// realistas (forma de payload de Shelly EM/3EM) y aplica LAS MISMAS reglas de guarda
// física / prioridad del huésped que exige `EnergyPort`, para poder probar el motor de
// decisión sin hardware.
import {
  ApprovalRequiredError,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  HVAC_MIN_CELSIUS,
  HVAC_MAX_CELSIUS,
  GUEST_PRIORITY_WINDOW_MS,
  HvacGuardViolationError,
  GuestPriorityActiveError,
  type EnergyPort,
  type MeterReading,
  type SetHvacStateInput,
  type HvacState,
  type ApprovalDecision,
} from "../port.ts";

/** Fixture realista: 3 circuitos tipo Shelly 3EM de un hotel pequeño (general, AC de pasillo, lavandería). */
const FIXTURE_CIRCUITS: Record<string, { baseKW: number; powerFactor: number }> = {
  "circuit-general": { baseKW: 8.2, powerFactor: 0.95 },
  "circuit-hvac-pasillo": { baseKW: 3.4, powerFactor: 0.88 },
  "circuit-lavanderia": { baseKW: 5.1, powerFactor: 0.91 },
};

export class SimulatedEnergyAdapter implements EnergyPort {
  readonly simulated = true as const;
  private readonly hvacState = new Map<string, HvacState>();
  private readonly guestPriorityUntil = new Map<string, number>();
  private cumulativeKWh: Record<string, number> = Object.fromEntries(
    Object.keys(FIXTURE_CIRCUITS).map((id) => [id, 1200 + Math.random() * 50]),
  );

  constructor(private readonly now: () => number = Date.now) {}

  status(): AdapterStatus {
    return { provider: "home-assistant-simulado", available: true, simulated: true };
  }

  async readMeter(circuitId: string): Promise<MeterReading> {
    const circuit = FIXTURE_CIRCUITS[circuitId];
    if (!circuit) throw new Error(`SimulatedEnergyAdapter: circuito desconocido ${circuitId}`);
    // Simula una pequeña variación de carga alrededor de la base del fixture.
    const kW = Number((circuit.baseKW * (0.9 + Math.random() * 0.2)).toFixed(3));
    this.cumulativeKWh[circuitId] = (this.cumulativeKWh[circuitId] ?? 0) + kW / 60; // ~1 lectura/min
    return {
      circuitId,
      kWh: Number(this.cumulativeKWh[circuitId]!.toFixed(3)),
      kW,
      powerFactor: circuit.powerFactor,
      ts: new Date(this.now()).toISOString(),
    };
  }

  private guestPriorityStillActive(roomId: string): number | undefined {
    const until = this.guestPriorityUntil.get(roomId);
    if (until === undefined) return undefined;
    if (this.now() >= until) {
      this.guestPriorityUntil.delete(roomId);
      return undefined;
    }
    return until;
  }

  async setHvacState(input: SetHvacStateInput, approval: ApprovalDecision): Promise<HvacState> {
    // 1. Guarda física local -- se aplica SIEMPRE, sin importar aprobación, origen, ni
    //    si la "nube" (en este simulador, nada externo) está disponible. Ver
    //    REQ-BO-028/029/REQ-SEG-015.
    if (input.setpointCelsius < HVAC_MIN_CELSIUS || input.setpointCelsius > HVAC_MAX_CELSIUS) {
      throw new HvacGuardViolationError(input.setpointCelsius);
    }

    // 2. Prioridad del huésped: una regla automática nunca puede pisar un override
    //    manual vigente (ventana de 2h).
    const activePriorityUntil = this.guestPriorityStillActive(input.roomId);
    if (activePriorityUntil !== undefined && input.origin === "regla_automatica") {
      throw new GuestPriorityActiveError(input.roomId, new Date(activePriorityUntil).toISOString());
    }

    // 3. Aprobación humana obligatoria (needsApproval, HVAC_SET_ACTION_META) -- ninguna
    //    acción física ocurre sin esto, sin importar quién origina el comando.
    if (!approval.approved) {
      throw new ApprovalRequiredError(
        "home-assistant-simulado",
        "setHvacState",
        "requiere aprobación humana previa (needsApproval)",
      );
    }

    if (input.origin === "override_manual_huesped") {
      this.guestPriorityUntil.set(input.roomId, this.now() + GUEST_PRIORITY_WINDOW_MS);
    }

    const state: HvacState = {
      roomId: input.roomId,
      mode: input.mode,
      setpointCelsius: input.setpointCelsius,
      updatedAt: new Date(this.now()).toISOString(),
      guestPriorityUntil: this.guestPriorityStillActive(input.roomId)
        ? new Date(this.guestPriorityUntil.get(input.roomId)!).toISOString()
        : undefined,
    };
    this.hvacState.set(input.roomId, state);
    return state;
  }

  /** Solo para pruebas: estado actual sin pasar por el puerto (para afirmar "no cambió"). */
  peekState(roomId: string): HvacState | undefined {
    return this.hvacState.get(roomId);
  }
}
