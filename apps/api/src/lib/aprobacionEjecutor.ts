// H6b/REQ-UX-006 · lógica compartida de "decidir una aprobación pendiente y, si queda
// aprobada, ejecutar la tool de dominio correspondiente" -- extraída de
// routes/aprobaciones.ts (endpoint autenticado del panel web) para que
// routes/aprobacionesWhatsapp.ts (webhook de botón de WhatsApp, REQ-UX-006: "sin
// requerir acceso al panel web") ejecute EXACTAMENTE la misma lógica de negocio,
// nunca una copia que pueda divergir.
import type { DbClient } from "@atiende-hoteles/db";
import { ApprovalError, PostgresApprovalQueue, buildToolContext, createRunBudget } from "@atiende-hoteles/agent-core";
import { buildToolExecutors } from "./agentTools.ts";
import { sharedWhatsappAdapter } from "./messaging.ts";
import { ApiError, Errors } from "./errors.ts";

export interface DecidirAprobacionParams {
  db: DbClient;
  hotelId: string;
  approvalId: string;
  actor: string;
  role?: string;
  decision: "aprobar" | "rechazar";
  textoExacto: string;
  requestId: string;
}

export interface DecidirAprobacionResultado {
  id: string;
  estado: string;
  ejecutado: boolean;
  summary?: unknown;
}

export async function decidirYEjecutarAprobacion(params: DecidirAprobacionParams): Promise<DecidirAprobacionResultado> {
  const approvalQueue = new PostgresApprovalQueue(params.db);
  let decided;
  try {
    decided = await approvalQueue.decide({
      approvalId: params.approvalId,
      actor: params.actor,
      role: params.role,
      decision: params.decision,
      textoExacto: params.textoExacto,
    });
  } catch (err) {
    if (err instanceof ApprovalError) throw new ApiError(409, "approval_invalid", err.message);
    throw err;
  }
  if (decided.hotelId !== params.hotelId) throw Errors.notFound("Solicitud de aprobación no encontrada.");

  if (decided.status !== "aprobada") {
    return { id: decided.id, estado: decided.status, ejecutado: false };
  }

  // A4 (auditoria-2): reclamación atómica -- si esta aprobación ya se ejecutó antes
  // (por `AgentRunner` en una corrida en vivo, o por una llamada anterior/concurrente
  // a este mismo ejecutor, p.ej. panel web y botón de WhatsApp casi simultáneos),
  // `markExecuted()` devuelve `false` y NUNCA se vuelve a correr la tool.
  const puedeEjecutar = await approvalQueue.markExecuted(decided.id);
  if (!puedeEjecutar) {
    return { id: decided.id, estado: decided.status, ejecutado: false };
  }

  const storedInput = await approvalQueue.getStoredInput(decided.id);
  const executors = buildToolExecutors({ db: params.db, messaging: sharedWhatsappAdapter, simulated: true });
  const tool = executors[decided.toolName];
  if (!tool) {
    throw Errors.internal(`No hay ejecutor registrado para la tool "${decided.toolName}" (aprobación ${decided.id}).`);
  }
  const parsed = tool.inputSchema.safeParse(storedInput);
  if (!parsed.success) {
    throw Errors.internal(`El input almacenado para la aprobación ${decided.id} ya no es válido contra la tool.`);
  }

  const ctx = buildToolContext(
    { orgId: decided.orgId, hotelId: decided.hotelId, actor: { type: "staff", id: params.actor }, requestId: params.requestId },
    createRunBudget({}),
  );
  const result = await tool.run(ctx, parsed.data);

  return { id: decided.id, estado: decided.status, ejecutado: true, summary: result.summary };
}
