/**
 * `EnergyPort` -- lectura de telemetría de energía y control de HVAC vía hub local
 * (Home Assistant + Shelly EM/3EM + Tuya/Zigbee/ESPHome), ADR-011. Cubre REQ-BO-027,
 * REQ-BO-028, REQ-BO-029 (P0, SEG), REQ-INT-007 (P0). Ver docs/ARQUITECTURA.md ADR-011.
 *
 * Diseño deliberado: `EnergyPort` NUNCA importa ni referencia `@atiende-hoteles/mcp-locks`
 * (GOB-044/REQ-SEG-015 -- ver `tests/unit/mcp-servers/architecture/`), y `setHvacState`
 * está anotado con la misma forma de metadata que `defineTool` de `packages/agent-core`
 * (`effect: "external"`, `needsApproval: true`) para que el runtime de agentes (ADR-006)
 * pueda envolver este puerto en una tool sin reinterpretar sus reglas de aprobación.
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Guarda física local (REQ-BO-028/029, REQ-SEG-015): estos límites se aplican DENTRO del
// adaptador (edge), nunca solo en una capa de negocio remota -- "aunque caiga la nube".
// ---------------------------------------------------------------------------
export const HVAC_MIN_CELSIUS = 20;
export const HVAC_MAX_CELSIUS = 27;

/** Ventana de prioridad del huésped sobre el control remoto tras un override manual (REQ-BO-029). */
export const GUEST_PRIORITY_WINDOW_MS = 2 * 60 * 60 * 1000;

export const hvacModes = ["eco", "pre_enfriado", "apagado", "manual"] as const;
export const HvacMode = z.enum(hvacModes);
export type HvacMode = z.infer<typeof HvacMode>;

/**
 * Quién origina el comando. `regla_automatica` es el motor de reglas de energía;
 * `override_manual_huesped` es el huésped ejerciendo control directo (gana prioridad
 * 2h); `staff` es un miembro del hotel. Este campo es la base de la guarda de
 * prioridad -- NUNCA de la guarda de seguridad física (esa aplica siempre, sin
 * importar el origen).
 */
export const hvacCommandOrigins = ["regla_automatica", "override_manual_huesped", "staff"] as const;
export const HvacCommandOrigin = z.enum(hvacCommandOrigins);
export type HvacCommandOrigin = z.infer<typeof HvacCommandOrigin>;

export const MeterReading = z.object({
  circuitId: z.string().min(1),
  kWh: z.number().nonnegative(),
  kW: z.number().nonnegative(),
  powerFactor: z.number().min(0).max(1),
  ts: z.string().datetime(),
});
export type MeterReading = z.infer<typeof MeterReading>;

export const SetHvacStateInput = z.object({
  roomId: z.string().min(1),
  mode: HvacMode,
  setpointCelsius: z.number(),
  origin: HvacCommandOrigin,
});
export type SetHvacStateInput = z.infer<typeof SetHvacStateInput>;

export const HvacState = z.object({
  roomId: z.string().min(1),
  mode: HvacMode,
  setpointCelsius: z.number(),
  updatedAt: z.string().datetime(),
  /** Presente cuando el huésped tiene prioridad activa sobre el control remoto (REQ-BO-029). */
  guestPriorityUntil: z.string().datetime().optional(),
});
export type HvacState = z.infer<typeof HvacState>;

/**
 * Decisión de aprobación humana requerida para `setHvacState` (mismo shape que
 * `packages/agent-core` `ApprovalQueue`/`needsApproval`, sin acoplarse a esa
 * implementación): quien construya la tool de agente decide cómo se llena este objeto.
 */
export const ApprovalDecision = z.object({
  approved: z.boolean(),
  approvedBy: z.string().min(1),
  decisionId: z.string().min(1),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** Metadata de la acción, compatible con `defineTool({ effect, needsApproval })` de agent-core. */
export const HVAC_SET_ACTION_META = { effect: "external", needsApproval: true } as const;

/** El setpoint solicitado cae fuera de la guarda física local -- rechazado, nunca clamp silencioso. */
export class HvacGuardViolationError extends Error {
  readonly code = "hvac_guard_violation";
  constructor(readonly setpointCelsius: number) {
    super(
      `setpoint ${setpointCelsius}°C fuera de la guarda física local ` +
        `[${HVAC_MIN_CELSIUS}, ${HVAC_MAX_CELSIUS}]°C`,
    );
    this.name = "HvacGuardViolationError";
  }
}

/** Una regla automática intentó tomar control mientras el huésped conserva prioridad (REQ-BO-029). */
export class GuestPriorityActiveError extends Error {
  readonly code = "guest_priority_active";
  constructor(
    readonly roomId: string,
    readonly untilIso: string,
  ) {
    super(`la habitación ${roomId} está bajo prioridad del huésped hasta ${untilIso}`);
    this.name = "GuestPriorityActiveError";
  }
}

export interface EnergyPort {
  status(): AdapterStatus;

  /** Lectura, `effect: "read"` -- no requiere aprobación. */
  readMeter(circuitId: string): Promise<MeterReading>;

  /**
   * Acción física, `needsApproval: true` (`HVAC_SET_ACTION_META`). Lanza
   * `ApprovalRequiredError` (de `@atiende-hoteles/mcp-shared`) si `approval.approved`
   * es `false`, `HvacGuardViolationError` si el setpoint viola la guarda física (esto se
   * verifica INCLUSO con aprobación válida -- la guarda física nunca es saltable), y
   * `GuestPriorityActiveError` si `origin === "regla_automatica"` y el huésped tiene
   * prioridad activa.
   */
  setHvacState(input: SetHvacStateInput, approval: ApprovalDecision): Promise<HvacState>;
}
