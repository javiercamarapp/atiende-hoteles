/**
 * Registro único de conectores CFDI/PAC (REQ-INT-015/REQ-AGT-018, GOB-027/GOB-059/BP-141:
 * "prohibido `if provider === X` fuera del registro central"). Homólogo declarativo de
 * `packages/mcp-servers/pms/src/registry.ts` (PMS_CONNECTOR_REGISTRY) para el dominio de
 * timbrado fiscal -- REQ-INT-015 exige que el patrón de "registro único" no sea
 * exclusivo de PMS, así que este archivo enumera en un único lugar los PAC soportados,
 * su orden de conmutación primario/secundario y su estado real.
 *
 * Orden = mismo orden con el que `apps/api/src/app.ts` construye `DualPacCfdiPort`
 * (Finkok primario, SW Sapien secundario) -- ese wiring compone dos adaptadores ya
 * construidos, no bifurca por `provider === "finkok"`, así que este registro no
 * reemplaza esa composición, solo la documenta y la hace verificable en un único lugar.
 *
 * `status` refleja el estado REAL del código de este repo, nunca aspiracional: ambos PAC
 * tienen adaptador real implementado (`finkok-adapter.ts`/`sw-sapien-adapter.ts`, cada
 * uno "[PENDIENTE DE CREDENCIALES]" -- ver sus propios docstrings) -- "implementado" aquí
 * significa que el código del adaptador existe contra el contrato público documentado del
 * PAC, NO que haya CSD/credenciales reales configuradas en este entorno (eje de runtime,
 * `AdapterStatus.available`) ni que el PAC final ya esté decidido: `port.ts` documenta
 * explícitamente que Finkok/SW Sapien son "ejemplos de proveedores PAC mexicanos reales
 * de conocimiento público" y que la elección final queda pendiente del fundador
 * (ver README.md) -- este registro no resuelve esa decisión de negocio, solo evita que
 * el nombre de un PAC concreto se disperse fuera de un único lugar mientras se decide.
 */

export type CfdiConnectorStatus = "implementado" | "pendiente";

export interface CfdiConnectorRegistryEntry {
  /** Identificador estable del PAC -- este es el ÚNICO lugar donde se declara la lista
   *  cerrada de PAC soportados; ningún otro archivo debe bifurcar lógica con
   *  `if (provider === "finkok")` fuera de aquí. */
  provider: "finkok" | "sw_sapien";
  /** Orden de conmutación primario(1)/secundario(2) en `DualPacCfdiPort`. Debe ser
   *  estrictamente ascendente y sin huecos -- verificado en
   *  tests/unit/mcp-servers/cfdi/registro-conectores.spec.ts. */
  priority: 1 | 2;
  label: string;
  status: CfdiConnectorStatus;
  notes: string;
}

export const CFDI_CONNECTOR_REGISTRY: readonly CfdiConnectorRegistryEntry[] = [
  {
    provider: "finkok",
    priority: 1,
    label: "Finkok",
    status: "implementado",
    notes:
      "Adaptador real (finkok-adapter.ts, [PENDIENTE DE CREDENCIALES]) + doble de prueba " +
      "(FakeFinkokAdapter). PAC primario en DualPacCfdiPort tal como se conecta hoy en app.ts.",
  },
  {
    provider: "sw_sapien",
    priority: 2,
    label: "SW Sapien",
    status: "implementado",
    notes:
      "Adaptador real (sw-sapien-adapter.ts, [PENDIENTE DE CREDENCIALES]) + doble de prueba " +
      "(FakeSwSapienAdapter). PAC secundario en DualPacCfdiPort (conmutación si el primario falla).",
  },
] as const;

export function getCfdiConnectorRegistry(): readonly CfdiConnectorRegistryEntry[] {
  return CFDI_CONNECTOR_REGISTRY;
}
