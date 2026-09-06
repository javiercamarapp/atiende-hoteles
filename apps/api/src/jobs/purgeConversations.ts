// auditoria-2/legal [ALTO]: "retención configurable por hotel para conversation/message
// con purga programada". `hotel_messaging_config.conversation_retention_days`
// (migración packages/db/migrations/0069) fija cuántos días conserva ESE hotel su
// historial de conversaciones/mensajes de WhatsApp antes de purgarse -- NULL usa el
// default de la plataforma de abajo.
//
// pendiente-decision: el NÚMERO exacto de `DEFAULT_CONVERSATION_RETENTION_DAYS` es una
// decisión de negocio/legal (cuánto necesita el hotel conservar el historial de
// conversación para atender una disputa/reclamo vs. minimización de datos LFPDPPP) que
// el fundador/equipo legal debe confirmar -- 730 días (2 años) se usa aquí como
// placeholder conservador (mismo orden de magnitud que la prescripción civil/mercantil
// más común en México), NUNCA se presenta como el plazo legal definitivo. Ver
// docs/auditoria-2/correccion-A-seguridad-legal.md.
export const DEFAULT_CONVERSATION_RETENTION_DAYS = 730;

import type { DbClient } from "@atiende-hoteles/db";

export interface PurgeConversationsResult {
  deletedConversations: number;
  deletedMessages: number;
}

export interface PurgeConversationsOptions {
  batchSize?: number;
}

/** Purga `conversation` (y sus `message`, por ON DELETE CASCADE) de UN hotel cuya
 *  última actividad (`last_message_at`, o `created_at` si nunca tuvo mensajes) ya
 *  superó su retención configurada -- nunca purga una conversación `abierta` con
 *  actividad reciente, solo la que ya venció su ventana de retención. */
export async function purgeExpiredConversations(
  db: DbClient,
  params: { hotelId: string; tenantId: string; retentionDays: number | null },
  opts: PurgeConversationsOptions = {},
): Promise<PurgeConversationsResult> {
  const batchSize = opts.batchSize ?? 200;
  if (batchSize < 1) throw new Error("batch_size_invalido: debe ser >= 1.");
  const retentionDays = params.retentionDays ?? DEFAULT_CONVERSATION_RETENTION_DAYS;
  if (retentionDays <= 0) throw new Error("retention_days_invalido: debe ser > 0.");

  let deletedConversations = 0;
  let deletedMessages = 0;

  for (;;) {
    const { rows: messageRows } = await db.query<{ id: string }>(
      `delete from public.message
       where conversation_id in (
         select id from public.conversation
         where hotel_id = $1
           and coalesce(last_message_at, created_at) + ($2 || ' days')::interval < now()
         limit $3
       )
       returning id;`,
      [params.hotelId, String(retentionDays), batchSize],
    );
    deletedMessages += messageRows.length;

    const { rows: conversationRows } = await db.query<{ id: string }>(
      `delete from public.conversation
       where id in (
         select id from public.conversation
         where hotel_id = $1
           and coalesce(last_message_at, created_at) + ($2 || ' days')::interval < now()
         limit $3
       )
       returning id;`,
      [params.hotelId, String(retentionDays), batchSize],
    );
    deletedConversations += conversationRows.length;

    if (conversationRows.length < batchSize) break;
  }

  if (deletedConversations > 0) {
    await db.query("select public.record_audit_log($1, $2, 'conversation.purged', 'conversation', null, $3);", [
      params.tenantId,
      params.hotelId,
      JSON.stringify({ deletedConversations, deletedMessages, retentionDays }),
    ]);
  }

  return { deletedConversations, deletedMessages };
}
