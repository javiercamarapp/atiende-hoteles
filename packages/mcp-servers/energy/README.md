# @atiende-hoteles/mcp-energy

`EnergyPort` -- telemetría de energía y control de HVAC vía hub local, ADR-011. Cubre
REQ-BO-027, REQ-BO-028, REQ-BO-029 (P0, SEG), REQ-INT-007 (P0). Hito **H11**. Ver
`docs/ARQUITECTURA.md` ADR-011.

## Contrato (`src/port.ts`)

- `readMeter(circuitId)` -- lectura (`effect: "read"`, sin aprobación): `{kWh, kW,
  powerFactor, ts}`, forma de payload de Shelly EM/3EM.
- `setHvacState(input, approval)` -- acción física (`HVAC_SET_ACTION_META = { effect:
  "external", needsApproval: true }`, mismo shape que `defineTool` de
  `packages/agent-core`). Tres guardas independientes, en este orden:
  1. **Guarda física local** (`HVAC_MIN_CELSIUS`/`HVAC_MAX_CELSIUS` = 20-27°C):
     se aplica SIEMPRE, incluso con aprobación válida -- `HvacGuardViolationError`.
  2. **Prioridad del huésped** (`GUEST_PRIORITY_WINDOW_MS` = 2h): una regla
     automática nunca puede pisar un override manual reciente del huésped --
     `GuestPriorityActiveError`.
  3. **Aprobación humana** (`ApprovalDecision`): sin `approved: true`, lanza
     `ApprovalRequiredError` (de `@atiende-hoteles/mcp-shared`) -- ninguna acción física
     ocurre sin ella.

**Aislamiento estructural (GOB-044/REQ-SEG-015):** este paquete NUNCA importa
`@atiende-hoteles/mcp-locks` -- verificado por análisis estático en
`tests/unit/mcp-servers/architecture/lock-isolation.spec.ts`.

## Adaptador real (`src/adapters/home-assistant-adapter.ts`)

**[PENDIENTE DE HARDWARE]** -- requiere `HOME_ASSISTANT_BASE_URL` y
`HOME_ASSISTANT_LONG_LIVED_TOKEN` (hub Home Assistant local + medidores Shelly +
HVAC Tuya/Zigbee/ESPHome). Sin hardware, `status()` reporta `unavailable`; la guarda
física y la exigencia de aprobación se verifican ANTES de comprobar disponibilidad de
hardware (nunca se saltan por falta de conexión).

## Adaptador simulado (`src/adapters/simulated-energy-adapter.ts`)

`SimulatedEnergyAdapter` (comentario `// SIMULADO` en el código, `simulated: true`).
Fixtures de 3 circuitos (general/HVAC de pasillo/lavandería) con variación de carga
realista; aplica las tres guardas exactamente igual que el adaptador real las
aplicaría.

## Pruebas

`tests/unit/mcp-servers/energy/` cubre: rechazo de setpoint fuera de 20-27°C con y sin
aprobación, rechazo sin aprobación con setpoint válido, prioridad de 2h del huésped
sobre reglas automáticas, y que ninguna de estas pruebas requiere hardware.

## Estado

**[PENDIENTE DE HARDWARE]** -- REQ-BO-027/028/029/INT-007 cubiertos con el adaptador
simulado; adaptador real pendiente de un hotel piloto con el kit de sensores (H07-040).
