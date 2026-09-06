// Prueba de contrato de EnergyPort (ADR-011, REQ-BO-027/028/029, REQ-INT-007): lectura de
// consumo, y setpoint de HVAC con needsApproval + guarda física + prioridad del huésped.
// "Ninguna acción física ocurre sin aprobación" se verifica explícitamente aquí.
import { describe, expect, it } from "vitest";
import {
  SimulatedEnergyAdapter,
  HomeAssistantAdapter,
  HVAC_MIN_CELSIUS,
  HVAC_MAX_CELSIUS,
  HVAC_SET_ACTION_META,
  HvacGuardViolationError,
  GuestPriorityActiveError,
} from "@atiende-hoteles/mcp-energy";
import { ApprovalRequiredError, PortUnavailableError } from "@atiende-hoteles/mcp-shared";

const approved = { approved: true, approvedBy: "gerente-1", decisionId: "dec-1" };
const notApproved = { approved: false, approvedBy: "gerente-1", decisionId: "dec-2" };

describe("HVAC_SET_ACTION_META", () => {
  it("declara la acción como effect:external + needsApproval:true (forma compatible con defineTool)", () => {
    expect(HVAC_SET_ACTION_META).toEqual({ effect: "external", needsApproval: true });
  });
});

describe("SimulatedEnergyAdapter.readMeter -- lectura, sin aprobación", () => {
  it("retorna una lectura con la forma de un medidor Shelly EM/3EM", async () => {
    const adapter = new SimulatedEnergyAdapter();
    const reading = await adapter.readMeter("circuit-general");
    expect(reading.circuitId).toBe("circuit-general");
    expect(reading.kW).toBeGreaterThan(0);
    expect(reading.powerFactor).toBeGreaterThan(0);
    expect(reading.powerFactor).toBeLessThanOrEqual(1);
  });

  it("un circuito desconocido lanza en vez de inventar una lectura", async () => {
    const adapter = new SimulatedEnergyAdapter();
    await expect(adapter.readMeter("circuito-inexistente")).rejects.toThrow();
  });
});

describe("SimulatedEnergyAdapter.setHvacState -- guarda física local (20-27°C)", () => {
  it("rechaza un setpoint por debajo de 20°C incluso con aprobación válida", async () => {
    const adapter = new SimulatedEnergyAdapter();
    await expect(
      adapter.setHvacState(
        { roomId: "101", mode: "manual", setpointCelsius: HVAC_MIN_CELSIUS - 1, origin: "staff" },
        approved,
      ),
    ).rejects.toBeInstanceOf(HvacGuardViolationError);
    expect(adapter.peekState("101")).toBeUndefined(); // ninguna acción física ocurrió
  });

  it("rechaza un setpoint por encima de 27°C incluso con aprobación válida", async () => {
    const adapter = new SimulatedEnergyAdapter();
    await expect(
      adapter.setHvacState(
        { roomId: "101", mode: "manual", setpointCelsius: HVAC_MAX_CELSIUS + 1, origin: "staff" },
        approved,
      ),
    ).rejects.toBeInstanceOf(HvacGuardViolationError);
  });

  it("acepta el límite inclusive 20°C y 27°C con aprobación", async () => {
    const adapter = new SimulatedEnergyAdapter();
    const low = await adapter.setHvacState(
      { roomId: "101", mode: "eco", setpointCelsius: HVAC_MIN_CELSIUS, origin: "staff" },
      approved,
    );
    expect(low.setpointCelsius).toBe(HVAC_MIN_CELSIUS);
    const high = await adapter.setHvacState(
      { roomId: "102", mode: "eco", setpointCelsius: HVAC_MAX_CELSIUS, origin: "staff" },
      approved,
    );
    expect(high.setpointCelsius).toBe(HVAC_MAX_CELSIUS);
  });
});

describe("SimulatedEnergyAdapter.setHvacState -- ninguna acción física sin aprobación", () => {
  it("un setpoint válido SIN aprobación se rechaza con ApprovalRequiredError", async () => {
    const adapter = new SimulatedEnergyAdapter();
    await expect(
      adapter.setHvacState({ roomId: "103", mode: "eco", setpointCelsius: 26, origin: "regla_automatica" }, notApproved),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(adapter.peekState("103")).toBeUndefined();
  });

  it("con aprobación válida y setpoint válido, la acción sí se ejecuta", async () => {
    const adapter = new SimulatedEnergyAdapter();
    const state = await adapter.setHvacState(
      { roomId: "104", mode: "eco", setpointCelsius: 26, origin: "regla_automatica" },
      approved,
    );
    expect(state.mode).toBe("eco");
    expect(adapter.peekState("104")).toEqual(state);
  });
});

describe("SimulatedEnergyAdapter -- prioridad de 2h del huésped (REQ-BO-029)", () => {
  it("tras un override manual del huésped, una regla automática NO puede tomar control en las siguientes 2h", async () => {
    let now = 0;
    const adapter = new SimulatedEnergyAdapter(() => now);
    await adapter.setHvacState(
      { roomId: "201", mode: "manual", setpointCelsius: 22, origin: "override_manual_huesped" },
      approved,
    );
    now += 60 * 60 * 1000; // 1h después, dentro de la ventana de 2h
    await expect(
      adapter.setHvacState({ roomId: "201", mode: "eco", setpointCelsius: 26, origin: "regla_automatica" }, approved),
    ).rejects.toBeInstanceOf(GuestPriorityActiveError);
  });

  it("pasadas las 2h, la regla automática recupera el control", async () => {
    let now = 0;
    const adapter = new SimulatedEnergyAdapter(() => now);
    await adapter.setHvacState(
      { roomId: "202", mode: "manual", setpointCelsius: 22, origin: "override_manual_huesped" },
      approved,
    );
    now += 2 * 60 * 60 * 1000 + 1;
    const state = await adapter.setHvacState(
      { roomId: "202", mode: "eco", setpointCelsius: 26, origin: "regla_automatica" },
      approved,
    );
    expect(state.mode).toBe("eco");
  });

  it("el staff SÍ puede actuar aunque el huésped tenga prioridad activa (la prioridad es solo frente a reglas automáticas)", async () => {
    let now = 0;
    const adapter = new SimulatedEnergyAdapter(() => now);
    await adapter.setHvacState(
      { roomId: "203", mode: "manual", setpointCelsius: 22, origin: "override_manual_huesped" },
      approved,
    );
    now += 60 * 60 * 1000;
    const state = await adapter.setHvacState(
      { roomId: "203", mode: "manual", setpointCelsius: 23, origin: "staff" },
      approved,
    );
    expect(state.setpointCelsius).toBe(23);
  });
});

describe("HomeAssistantAdapter (real) sin hardware -- declaración honesta", () => {
  const adapter = new HomeAssistantAdapter();

  it("status() reporta [PENDIENTE DE HARDWARE] sin inventar una lectura", () => {
    if (adapter.status().available) return;
    expect(adapter.status().reason).toMatch(/PENDIENTE DE HARDWARE/);
  });

  it("la guarda física se verifica ANTES que la disponibilidad de hardware", async () => {
    // Un setpoint fuera de rango se rechaza aunque no haya hub -- nunca se salta la guarda.
    await expect(
      adapter.setHvacState({ roomId: "1", mode: "manual", setpointCelsius: 40, origin: "staff" }, approved),
    ).rejects.toBeInstanceOf(HvacGuardViolationError);
  });

  it("la exigencia de aprobación se verifica ANTES que la disponibilidad de hardware", async () => {
    await expect(
      adapter.setHvacState({ roomId: "1", mode: "manual", setpointCelsius: 24, origin: "staff" }, notApproved),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("readMeter sin hardware lanza PortUnavailableError, nunca una lectura inventada", async () => {
    if (adapter.status().available) return;
    await expect(adapter.readMeter("circuit-general")).rejects.toBeInstanceOf(PortUnavailableError);
  });
});
