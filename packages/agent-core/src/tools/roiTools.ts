// H7 · Tool de dominio real para registrar un `ROIEvent` (REQ-AGT-003/REQ-REV-018,
// packages/db/migrations/0026_roi_event.sql): cada agente con impacto económico llama
// esta tool para dejar constancia del valor generado, con su método contrafactual y
// nivel de confianza explícitos -- nunca se inventa una cifra sin esos dos campos.
//
// effect="write" (no "money"): esta tool NO mueve dinero real, solo REGISTRA un
// estimado/observación de valor económico -- GOB-026 (aprobación humana) aplica a
// acciones que mueven dinero de verdad (cobrar, reembolsar, cambiar tarifa), no a
// anotar en un tablero de ROI que un agente ya hizo su trabajo.
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import type { SqlClient } from "../sql.ts";

export interface RoiToolDeps {
  readonly db: SqlClient;
  /** Nombre del agente que produce el evento (packages/agent-core/src/agents.ts) --
   * viene de las deps de quien construye la tool, nunca del input del modelo (mismo
   * principio que hotelId/orgId: identidad de "quién" nunca es un campo del esquema). */
  readonly agentName: string;
}

const registrarEventoRoiInput = z.object({
  tipoEvento: z.string().trim().min(1).max(60),
  montoEstimado: z.number().nonnegative().max(10_000_000).optional(),
  montoVerificado: z.number().nonnegative().max(10_000_000).optional(),
  metodoContrafactual: z.string().trim().min(1).max(300),
  confianza: z.number().min(0).max(1),
  supuestoVersion: z.string().trim().min(1).max(40).default("H17-v1"),
  referenciaTipo: z.enum(["reserva", "folio", "tarea", "conversacion", "ninguna"]).default("ninguna"),
  referenciaCodigo: z.string().trim().max(100).optional(),
  notas: z.string().trim().max(500).optional(),
});
export type RegistrarEventoRoiInput = z.infer<typeof registrarEventoRoiInput>;

export const REGISTRAR_EVENTO_ROI_TOOL_NAME = "registrar_evento_roi";

/** REQ-AGT-003/REQ-REV-018 (H17-001): registra un evento de ROI con los 4 campos que
 * exige H17 (monto_verificado, monto_estimado, método contrafactual, confianza) más el
 * versionado explícito del supuesto usado. `estimado` lo recalcula un trigger de BD
 * (0026) a partir de si hay `montoVerificado` -- nunca se confía en lo que mande el
 * modelo para esa bandera. */
export function createRegistrarEventoRoiTool(deps: RoiToolDeps): ToolDefinition<RegistrarEventoRoiInput> {
  return defineTool({
    name: REGISTRAR_EVENTO_ROI_TOOL_NAME,
    description:
      "Registra un evento de ROI (valor económico estimado o verificado) generado por esta acción, con su " +
      "método contrafactual y nivel de confianza. Requiere al menos monto estimado o monto verificado.",
    inputSchema: registrarEventoRoiInput,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      if (input.montoEstimado === undefined && input.montoVerificado === undefined) {
        return {
          ok: false,
          summary: "No se registró el evento de ROI: falta monto estimado o monto verificado (al menos uno).",
        };
      }
      const createdBy = ctx.actor.type === "staff" ? ctx.actor.id : ctx.actor.type;
      const { rows } = await deps.db.query<{ id: string; estimado: boolean }>(
        `insert into public.roi_event
           (org_id, hotel_id, agent_name, tipo_evento, monto_estimado, monto_verificado,
            metodo_contrafactual, confianza, supuesto_version, referencia_tipo, referencia_codigo,
            notas, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning id, estimado;`,
        [
          ctx.orgId,
          ctx.hotelId,
          deps.agentName,
          input.tipoEvento,
          input.montoEstimado ?? null,
          input.montoVerificado ?? null,
          input.metodoContrafactual,
          input.confianza,
          input.supuestoVersion,
          input.referenciaTipo,
          input.referenciaCodigo ?? null,
          input.notas ?? null,
          createdBy,
        ],
      );
      const row = rows[0]!;
      const montoTexto =
        input.montoVerificado !== undefined
          ? `$${input.montoVerificado.toFixed(2)} verificado`
          : `$${(input.montoEstimado ?? 0).toFixed(2)} estimado`;
      return {
        ok: true,
        summary: `Evento de ROI "${input.tipoEvento}" registrado (${montoTexto}, confianza ${(input.confianza * 100).toFixed(0)}%).`,
        data: { roiEventId: row.id, estimado: row.estimado },
      };
    },
  });
}
