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
import { defineTool, type RoiEventDraft, type ToolDefinition } from "../tool.ts";
import type { SqlClient } from "../sql.ts";
import type { ToolContext } from "../context.ts";
import type { RoiEventRecorder } from "../runner.ts";

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

/** INSERT compartido hacia `public.roi_event` (migración 0026): lo usan tanto la tool
 * manual `registrar_evento_roi` (el modelo decide cuándo llamarla) como
 * `createPostgresRoiEventRecorder` (REQ-AGT-003: el propio `AgentRunner` la llama SIN
 * intervención del modelo para toda tool `effect="money"` que se ejecuta con éxito) --
 * un solo camino hacia la tabla evita que las dos rutas diverjan en qué columnas
 * escriben. `estimado` lo recalcula un trigger de BD (0026) a partir de si hay
 * `montoVerificado` -- nunca se confía en lo que mande el llamador para esa bandera. */
async function insertRoiEvent(
  db: SqlClient,
  ctx: ToolContext,
  agentName: string,
  draft: RoiEventDraft,
): Promise<{ id: string; estimado: boolean }> {
  const createdBy = ctx.actor.type === "staff" ? ctx.actor.id : ctx.actor.type;
  const { rows } = await db.query<{ id: string; estimado: boolean }>(
    `insert into public.roi_event
       (org_id, hotel_id, agent_name, tipo_evento, monto_estimado, monto_verificado,
        metodo_contrafactual, confianza, supuesto_version, referencia_tipo, referencia_codigo,
        notas, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id, estimado;`,
    [
      ctx.orgId,
      ctx.hotelId,
      agentName,
      draft.tipoEvento,
      draft.montoEstimado ?? null,
      draft.montoVerificado ?? null,
      draft.metodoContrafactual,
      draft.confianza,
      draft.supuestoVersion ?? "H17-v1",
      draft.referenciaTipo ?? "ninguna",
      draft.referenciaCodigo ?? null,
      draft.notas ?? null,
      createdBy,
    ],
  );
  return rows[0]!;
}

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
      const row = await insertRoiEvent(deps.db, ctx, deps.agentName, input);
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

/** REQ-AGT-003 (H17-001/GOB-037): implementación real de `RoiEventRecorder` (runner.ts)
 * contra `public.roi_event` -- es lo que conecta la cobertura automática del
 * `AgentRunner` (100% de las tools `effect="money"` que ejecutan con éxito, sin
 * excepción, sin depender de que el modelo llame `registrar_evento_roi`) a la base de
 * datos real, reusando el MISMO `insertRoiEvent` que ya usa la tool manual. Valida el
 * borrador ANTES de tocar la BD (falla cerrada con un mensaje claro) en vez de dejar
 * que Postgres rechace el INSERT por un CHECK constraint genérico -- mismos dos
 * invariantes que exige `packages/db/migrations/0026_roi_event.sql`: al menos un monto,
 * y confianza dentro de [0,1] (Zod ya lo valida para la tool manual vía su schema; una
 * tool `money` que construye su `RoiEventDraft` a mano no pasa por ese schema). */
export function createPostgresRoiEventRecorder(db: SqlClient): RoiEventRecorder {
  return {
    async record(ctx, agentName, draft) {
      if (draft.montoEstimado === undefined && draft.montoVerificado === undefined) {
        throw new Error(
          `ROIEvent inválido (agentName="${agentName}", tipoEvento="${draft.tipoEvento}"): falta monto ` +
            "estimado o monto verificado (al menos uno), REQ-AGT-003.",
        );
      }
      if (draft.confianza < 0 || draft.confianza > 1) {
        throw new Error(
          `ROIEvent inválido (agentName="${agentName}", tipoEvento="${draft.tipoEvento}"): confianza ` +
            `fuera de rango [0,1] (${draft.confianza}).`,
        );
      }
      await insertRoiEvent(db, ctx, agentName, draft);
    },
  };
}
