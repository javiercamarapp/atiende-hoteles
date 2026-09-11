/**
 * Registro único de conectores PMS/channel-manager (REQ-REV-010/REQ-REV-008,
 * GOB-027/GOB-059/REQ-AGT-018: "prohibido `if provider === X`/`if pms === X` fuera del
 * registro central"). Orden de prioridad de CONSTRUCCIÓN, consenso mayoritario de las
 * fuentes de investigación (H01-H04, H08-H09, H11, H15-001) documentado en
 * `docs/REQUISITOS.md` §4 punto 8: Cloudbeds → Mews → SiteMinder/pmsXchange → OHIP
 * (Apaleo como referencia, sin implementación propia todavía).
 *
 * `status` refleja el estado REAL de este repo, nunca aspiracional: solo Cloudbeds
 * tiene adaptador implementado hoy (`adapters/cloudbeds-adapter.ts`, con su doble de
 * prueba `fake-cloudbeds-adapter.ts` para no bloquear desarrollo sin sandbox real,
 * REQ-REV-010) -- los demás siguen `"pendiente"` hasta que exista su adaptador.
 *
 * REQ-REV-008/REQ-RES-022: mientras la restricción de fase esté vigente (H15-006, ver
 * docs/REQUISITOS.md §3.2), NINGUNA conectividad OTA (Booking/Expedia/Airbnb) propia
 * se construye -- toda disponibilidad/tarifa hacia OTA pasa exclusivamente por el
 * `provider` de este registro (el channel manager/PMS certificado), nunca por una
 * llamada directa a una API de OTA. `scripts/checks/no-ota-directa.ts` y
 * `scripts/checks/orden-conectores-pms.ts` verifican esto de forma estática.
 *
 * REQ-REV-015/REQ-QA-010: cada entrada declara sus `capabilities` -- el subconjunto de
 * operaciones de `PmsPort` (ver `port.ts`) que el conector realmente implementa hoy,
 * NUNCA aspiracional. `scripts/checks/registro-conectores-pms.ts` audita, de solo
 * lectura, que cada capability aquí declarada tenga un contract test que la cubra
 * (marcador `contrato-capacidad-pms: <provider>:<capability>` en un `it(...)` bajo
 * `tests/unit/mcp-servers/pms/` o `tests/integration/contracts/`) -- una capability sin
 * ese marcador es un hallazgo bloqueante, no una advertencia silenciosa.
 */

export type PmsConnectorStatus = "implementado" | "pendiente";

/**
 * Capacidades del contrato `PmsPort` (ver `port.ts`) que un conector puede declarar.
 * Deliberadamente NO incluye `status()`: es introspección del propio adaptador
 * (¿hay credenciales?), no una operación de negocio contra el PMS -- no tiene sentido
 * pedirle un "contract test de capability" propio.
 */
export const PMS_CAPABILITIES = [
  "getReservation",
  "listRatePlans",
  "createCharge",
  "applyReservationUpdate",
  "updateHousekeepingStatus",
  "getGuestProfile",
  "verifyAndNormalizeWebhook",
] as const;
export type PmsCapability = (typeof PMS_CAPABILITIES)[number];

export interface PmsConnectorRegistryEntry {
  /** Identificador estable del proveedor -- este es el ÚNICO lugar donde se declara
   *  la lista cerrada de proveedores soportados; ningún otro archivo debe bifurcar
   *  lógica con `if (provider === "cloudbeds")` fuera de aquí. */
  provider: "cloudbeds" | "mews" | "siteminder" | "ohip";
  /** Orden de prioridad de construcción, 1 = primero. Debe ser estrictamente
   *  ascendente y sin huecos -- verificado en
   *  tests/unit/pms/registro-conectores.spec.ts. */
  priority: 1 | 2 | 3 | 4;
  label: string;
  status: PmsConnectorStatus;
  /** Capacidades de `PmsPort` que este conector declara implementadas HOY (ver
   *  docstring del módulo). Un conector `"pendiente"` declara `[]` -- no hay adaptador,
   *  no hay nada que un contract test pueda cubrir todavía. */
  capabilities: readonly PmsCapability[];
  notes: string;
}

export const PMS_CONNECTOR_REGISTRY: readonly PmsConnectorRegistryEntry[] = [
  {
    provider: "cloudbeds",
    priority: 1,
    label: "Cloudbeds",
    status: "implementado",
    capabilities: PMS_CAPABILITIES,
    notes: "Adaptador real (cloudbeds-adapter.ts) + doble de prueba (fake-cloudbeds-adapter.ts) para desarrollo sin sandbox.",
  },
  {
    provider: "mews",
    priority: 2,
    label: "Mews",
    status: "pendiente",
    capabilities: [],
    notes: "Sin adaptador todavía -- siguiente en el orden de construcción tras Cloudbeds.",
  },
  {
    provider: "siteminder",
    priority: 3,
    label: "SiteMinder / pmsXchange (SMX)",
    status: "pendiente",
    capabilities: [],
    notes: "Conector genérico OTA-XML vía pmsXchange/SMX (REQ-REV-011) -- sin adaptador todavía.",
  },
  {
    provider: "ohip",
    priority: 4,
    label: "Oracle OPERA (OHIP)",
    status: "pendiente",
    capabilities: [],
    notes: "Requiere patrocinio OHIP de Oracle; Apaleo queda como referencia de interfaz, sin implementación propia.",
  },
] as const;

export function getPmsConnectorRegistry(): readonly PmsConnectorRegistryEntry[] {
  return PMS_CONNECTOR_REGISTRY;
}
