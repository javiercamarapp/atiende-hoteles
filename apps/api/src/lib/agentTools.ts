// H6b · Puente entre las tools de dominio de agent-core y las rutas HTTP de staff:
// housekeeping/mantenimiento/mensajeria reutilizan las MISMAS tools que usaria el agente
// conversacional (una sola implementacion de la regla de negocio para ambos caminos).
// `buildToolExecutors()` arma el registro por `tool_name` que routes/aprobaciones.ts usa
// para ejecutar la tool correspondiente justo cuando una solicitud de `agent_approval`
// llega a "aprobada" fuera de una corrida de `AgentRunner` (dos peticiones HTTP separadas
// de dos aprobadores distintos, no una sola corrida de agente).
import type { DbClient } from "@atiende-hoteles/db";
import {
  createAuthorizeMaintenanceExpenseTool,
  createSendWhatsappTemplateTool,
  type ToolDefinition,
  type WhatsappSenderLike,
} from "@atiende-hoteles/agent-core";

export interface AgentToolDeps {
  readonly db: DbClient;
  readonly messaging: WhatsappSenderLike;
  /** true mientras `messaging` sea un adaptador simulado (ver `message.simulated`). */
  readonly simulated: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registro heterogeneo: cada tool trae su propio TInput, igual que ToolRegistry de agent-core.
export function buildToolExecutors(deps: AgentToolDeps): Record<string, ToolDefinition<any>> {
  const tools = [
    createAuthorizeMaintenanceExpenseTool({ db: deps.db }),
    createSendWhatsappTemplateTool({ db: deps.db, messaging: deps.messaging, simulated: deps.simulated }),
  ];
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}
