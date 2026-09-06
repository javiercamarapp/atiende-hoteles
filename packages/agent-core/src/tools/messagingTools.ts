// H6b · Tool de dominio real para enviar un mensaje de WhatsApp por plantilla
// (packages/mcp-servers/whatsapp `MessagingPort`) sobre `conversation`/`message`
// (packages/db/migrations/0044_conversation_message.sql).
//
// `WhatsappSenderLike` es un tipo ESTRUCTURAL (duck typing), no una importacion de
// `@atiende-hoteles/mcp-whatsapp`: agent-core no depende de ese paquete, cualquier
// implementacion de `MessagingPort` (el `FakeWhatsappAdapter` real de ese paquete, o un
// futuro adaptador de Meta) encaja sin adaptador.
//
// GOB-026 exige `needsApproval: true` en TODA tool effect="external" (`defineTool()` lo
// hace cumplir) -- no hay forma de declarar "needsApproval solo a veces" a nivel de tool
// (el flag es estatico). La distincion "plantilla transaccional -> sin espera humana" que
// pide REQ-HK-021/H09 se resuelve en la CAPA DE APROBACION, no en la tool:
// `createTransactionalTemplateApprovalQueue()` envuelve la `ApprovalQueue` real y
// auto-decide (como actor "sistema") las solicitudes de ESTA tool cuyo `templateName` esta
// en la lista de plantillas transaccionales del hotel (`hotel_messaging_config`); todo lo
// demas (mensaje libre, plantilla no transaccional) sigue esperando una decision humana
// real -- el `AgentRunner`/`tool.ts` no se tocan.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import type { SqlClient } from "../sql.ts";
import type { ApprovalQueue, RequestApprovalParams } from "../approval.ts";

export interface SentWhatsappMessage {
  readonly externalMessageId: string;
  readonly status: "enviado" | "entregado" | "leido" | "fallido";
}

/** Forma minima de `MessagingPort` (packages/mcp-servers/whatsapp) que esta tool necesita. */
export interface WhatsappSenderLike {
  sendTemplateMessage(input: {
    to: string;
    templateName: string;
    languageCode: string;
    parameters: string[];
    clientMessageId: string;
  }): Promise<SentWhatsappMessage>;
}

export interface MessagingToolDeps {
  readonly db: SqlClient;
  readonly messaging: WhatsappSenderLike;
  /** true si `messaging` es un adaptador simulado (sin credenciales reales de Meta) --
   * se persiste en `message.simulated` para que el frontend nunca aparente una entrega
   * real que no ocurrio (ver README del hito, "PENDIENTE DE CREDENCIALES"). */
  readonly simulated: boolean;
}

const sendWhatsappTemplateInput = z.object({
  guestPhone: z.string().trim().min(8).max(20),
  templateName: z.string().trim().min(1).max(60),
  languageCode: z.string().trim().min(2).max(10).default("es"),
  parameters: z.array(z.string().trim().max(200)).max(10).default([]),
});
export type SendWhatsappTemplateInput = z.infer<typeof sendWhatsappTemplateInput>;

export const SEND_WHATSAPP_TEMPLATE_TOOL_NAME = "enviar_mensaje_whatsapp_plantilla";

/** REQ-HUE-001/002, REQ-HK-002/013/021: envia una plantilla de WhatsApp aprobada a un
 * huesped. effect="external" + needsApproval=true SIEMPRE (GOB-026) -- ver comentario de
 * archivo para como las plantillas transaccionales evitan la espera humana sin violar esa
 * regla. */
export function createSendWhatsappTemplateTool(deps: MessagingToolDeps): ToolDefinition<SendWhatsappTemplateInput> {
  return defineTool({
    name: SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
    description: "Envía un mensaje de WhatsApp por plantilla aprobada a un huésped del hotel en curso.",
    inputSchema: sendWhatsappTemplateInput,
    effect: "external",
    needsApproval: true,
    run: async (ctx, input) => {
      const { rows: conversationRows } = await deps.db.query<{ id: string }>(
        `insert into public.conversation (tenant_id, hotel_id, channel, guest_phone)
         values ($1, $2, 'whatsapp', $3)
         on conflict (hotel_id, channel, guest_phone) where guest_phone is not null
         do update set updated_at = now()
         returning id;`,
        [ctx.orgId, ctx.hotelId, input.guestPhone],
      );
      const conversationId = conversationRows[0]!.id;

      const clientMessageId = `${ctx.requestId}:${input.templateName}:${randomUUID()}`;
      const sent = await deps.messaging.sendTemplateMessage({
        to: input.guestPhone,
        templateName: input.templateName,
        languageCode: input.languageCode,
        parameters: input.parameters,
        clientMessageId,
      });

      await deps.db.query(
        `insert into public.message
           (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body,
            requires_approval, client_message_id, external_message_id, delivery_status, simulated)
         values ($1, $2, $3, 'saliente', 'whatsapp', $4, $5, true, $6, $7, $8, $9);`,
        [
          ctx.orgId,
          ctx.hotelId,
          conversationId,
          input.templateName,
          `[plantilla:${input.templateName}] ${input.parameters.join(" | ")}`.trim(),
          clientMessageId,
          sent.externalMessageId,
          sent.status,
          deps.simulated,
        ],
      );

      return {
        ok: true,
        summary: `Mensaje de WhatsApp (plantilla "${input.templateName}") enviado a ${input.guestPhone}.`,
        data: { conversationId, externalMessageId: sent.externalMessageId, simulated: deps.simulated },
      };
    },
  });
}

export interface TransactionalTemplateCheckParams {
  readonly hotelId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export type TransactionalTemplateCheck = (
  params: TransactionalTemplateCheckParams,
) => boolean | Promise<boolean>;

/**
 * Envuelve una `ApprovalQueue` real (p.ej. `PostgresApprovalQueue`) para que las
 * solicitudes de `enviar_mensaje_whatsapp_plantilla` cuya plantilla este en la lista de
 * "transaccionales" del hotel (`hotel_messaging_config.transactional_templates`) se
 * auto-decidan como aprobadas por el actor "sistema" -- sin esperar a un humano -- mientras
 * cualquier otra solicitud (money, u otra plantilla externa) sigue el flujo normal de
 * `ApprovalQueue` sin cambios. No reabre ni reinterpreta solicitudes YA resueltas o
 * reusadas (idempotencia): solo actua sobre una solicitud recien creada en estado
 * "pendiente".
 */
export function createTransactionalTemplateApprovalQueue(
  inner: ApprovalQueue,
  isTransactional: TransactionalTemplateCheck,
  approverActor = "sistema:plantillas-transaccionales",
): ApprovalQueue {
  return {
    async request(params: RequestApprovalParams) {
      const created = await inner.request(params);
      if (created.status !== "pendiente") return created;
      const autoApprove = await isTransactional({
        hotelId: params.hotelId,
        toolName: params.toolName,
        input: params.input,
      });
      if (!autoApprove) return created;
      return inner.decide({
        approvalId: created.id,
        actor: approverActor,
        role: "sistema",
        decision: "aprobar",
        textoExacto: `Plantilla transaccional preaprobada por configuración del hotel: ${created.textoMostrado}`,
      });
    },
    decide: (params) => inner.decide(params),
    get: (id) => inner.get(id),
    expirePending: (now) => inner.expirePending(now),
    markExecuted: (id, now) => inner.markExecuted(id, now),
  };
}

/** Helper de wiring: construye el `isTransactional` para
 * `createTransactionalTemplateApprovalQueue` a partir de la config real del hotel
 * (`hotel_messaging_config.transactional_templates`), solo para la tool de WhatsApp --
 * cualquier otra tool (p.ej. `autorizar_gasto_mantenimiento`) nunca se auto-aprueba aqui. */
export function transactionalTemplateCheckFromDb(db: SqlClient): TransactionalTemplateCheck {
  return async ({ hotelId, toolName, input }) => {
    if (toolName !== SEND_WHATSAPP_TEMPLATE_TOOL_NAME) return false;
    const templateName = (input as { templateName?: unknown } | null)?.templateName;
    if (typeof templateName !== "string") return false;
    const { rows } = await db.query<{ transactional_templates: string[] }>(
      "select transactional_templates from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    const allowed = rows[0]?.transactional_templates ?? [];
    return allowed.includes(templateName);
  };
}
