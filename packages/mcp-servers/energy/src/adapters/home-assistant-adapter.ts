/**
 * Adaptador real contra un hub Home Assistant local (REST + WebSocket), orquestando
 * medidores Shelly EM/3EM (REST/MQTT/Modbus) y HVAC vía Tuya/Zigbee/ESPHome, ADR-011.
 * Esqueleto honesto: sin hub físico en esta máquina de desarrollo, se declara
 * `unavailable` -- NUNCA inventa una lectura de consumo ni mueve un HVAC real.
 *
 * [PENDIENTE DE HARDWARE] -- requiere `HOME_ASSISTANT_BASE_URL` (típicamente
 * `http://<hub-local>:8123`) y `HOME_ASSISTANT_LONG_LIVED_TOKEN`.
 */
import {
  PortUnavailableError,
  ApprovalRequiredError,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  HVAC_MIN_CELSIUS,
  HVAC_MAX_CELSIUS,
  HvacGuardViolationError,
  type EnergyPort,
  type MeterReading,
  type SetHvacStateInput,
  type HvacState,
  type ApprovalDecision,
} from "../port.ts";

const REQUIRED_ENV = ["HOME_ASSISTANT_BASE_URL", "HOME_ASSISTANT_LONG_LIVED_TOKEN"] as const;

/** Rutas REST documentadas de Home Assistant (`/api/states/<entity_id>`, `/api/services/<domain>/<service>`). */
export function homeAssistantStateUrl(baseUrl: string, entityId: string): string {
  return `${baseUrl}/api/states/${entityId}`;
}
export function homeAssistantServiceUrl(baseUrl: string, domain: string, service: string): string {
  return `${baseUrl}/api/services/${domain}/${service}`;
}

export class HomeAssistantAdapter implements EnergyPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "home-assistant", available: true, simulated: false };
    return {
      provider: "home-assistant",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE HARDWARE] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError(
        "home-assistant",
        `sin hub físico configurado en este entorno (faltan: ${this.credentials.missing.join(", ")})`,
      );
    }
  }

  async readMeter(circuitId: string): Promise<MeterReading> {
    this.assertAvailable();
    void circuitId;
    void homeAssistantStateUrl;
    throw new PortUnavailableError("home-assistant", "sin hardware físico en este entorno");
  }

  async setHvacState(input: SetHvacStateInput, approval: ApprovalDecision): Promise<HvacState> {
    // La guarda física local se verifica SIEMPRE, incluso antes de comprobar
    // disponibilidad de hardware -- nunca se salta por falta de conexión al hub.
    if (input.setpointCelsius < HVAC_MIN_CELSIUS || input.setpointCelsius > HVAC_MAX_CELSIUS) {
      throw new HvacGuardViolationError(input.setpointCelsius);
    }
    if (!approval.approved) {
      throw new ApprovalRequiredError("home-assistant", "setHvacState", "requiere aprobación humana previa");
    }
    this.assertAvailable();
    void homeAssistantServiceUrl;
    throw new PortUnavailableError("home-assistant", "sin hardware físico en este entorno");
  }
}
