// REQ-RES-013: seguimiento automático (48h / 7 días) de una `solicitud_grupo` sin
// respuesta. Mismo patrón exacto que `jobs/ticketEscalation.ts`: puro respecto al reloj
// -- SIEMPRE recibe `now` como parámetro (nunca `Date.now()` interno) y lo pasa como
// PARÁMETRO SQL en la comparación (`programado_para <= $now`), nunca usa el `now()` de
// Postgres -- así una corrida real (reloj real inyectado por
// `seguimientoSolicitudGrupoScheduler.ts`) y una prueba con "reloj simulado" ejercitan
// EXACTAMENTE la misma consulta.
//
// El mensaje de seguimiento va a un CONTACTO DE NEGOCIO (organizador del evento), no a
// un huésped con conversación abierta -- nunca hay ventana de servicio al cliente de
// 24h vigente para él (la solicitud lleva 48h/7 días SIN RESPUESTA por definición), así
// que Meta exige una plantilla aprobada (`sendTemplateMessage`), nunca `sendTextMessage`
// (ver el comentario de `MessagingPort.sendTextMessage`,
// packages/mcp-servers/whatsapp/src/port.ts: "Solo válido dentro de la ventana de 24h
// de conversación abierta por el huésped"). `messagingPort` es inyectable -- default
// `sharedWhatsappAdapter`, el MISMO singleton de producción que el resto de la API usa
// para WhatsApp (`apps/api/src/lib/messaging.ts`) -- para que las pruebas puedan
// inyectar su propio `FakeWhatsappAdapter`/espía sin tocar ese singleton compartido.
import type { DbClient } from "@atiende-hoteles/db";
import type { MessagingPort } from "@atiende-hoteles/mcp-whatsapp";
import { selectDueGroupFollowUps, type GroupFollowUpType, type PendingGroupFollowUp } from "@atiende-hoteles/domain-hotel";
import { sharedWhatsappAdapter } from "../lib/messaging.ts";

export interface RunGroupFollowUpsParams {
  hotelId: string;
  tenantId: string;
}

export interface RunGroupFollowUpsOptions {
  /** Reloj inyectable para pruebas deterministas -- default la hora real. */
  now?: () => Date;
  /** Adaptador de mensajería inyectable -- default `sharedWhatsappAdapter`. */
  messagingPort?: MessagingPort;
  /** Nombre de plantilla de Meta por tipo de seguimiento -- inyectable solo para
   *  pruebas; en producción SIEMPRE se usa el default documentado abajo (las
   *  plantillas reales las aprueba Meta por nombre exacto, un hotel no puede tener un
   *  nombre distinto por sí mismo en este primer corte). */
  templateNameByType?: Record<GroupFollowUpType, string>;
  languageCode?: string;
}

export interface ExecutedGroupFollowUp {
  seguimientoId: string;
  solicitudId: string;
  tipo: GroupFollowUpType;
  organizadorTelefono: string;
  externalMessageId: string;
}

export interface RunGroupFollowUpsResult {
  ejecutados: ExecutedGroupFollowUp[];
}

/** Plantillas de WhatsApp del seguimiento automático -- catálogo cerrado de 2 (una por
 *  `GroupFollowUpType`), a diferencia de `roi_event.tipo_evento` (catálogo abierto):
 *  aquí SÍ hay solo 2 ventanas posibles (48h/7d, literal del REQ), así que un nombre
 *  fijo por tipo es correcto y no una limitación artificial. */
const DEFAULT_TEMPLATE_NAME_BY_TYPE: Record<GroupFollowUpType, string> = {
  "48h": "seguimiento_solicitud_grupo_48h",
  "7d": "seguimiento_solicitud_grupo_7d",
};

interface CandidateFollowUp extends PendingGroupFollowUp {
  solicitudId: string;
  organizadorNombre: string;
  organizadorTelefono: string;
}

interface CandidateRow {
  id: string;
  solicitud_id: string;
  tipo: GroupFollowUpType;
  programado_para: string;
  ejecutado_en: string | null;
  organizador_nombre: string;
  organizador_telefono: string;
}

/** Ejecuta todos los seguimientos vencidos y aún no ejecutados de `hotelId`.
 *  Solicitudes ya `respondida`/`cerrada` quedan excluidas por el propio JOIN (`where
 *  s.estado = 'pendiente'`), así que un seguimiento NUNCA se dispara si el organizador
 *  ya contestó -- ni siquiera si su fila de `seguimiento_solicitud_grupo` sigue con
 *  `ejecutado_en is null` (la respuesta no borra esas filas, simplemente deja de
 *  calificar para el JOIN). Idempotente: una segunda corrida sobre los mismos
 *  seguimientos ya ejecutados no vuelve a tocarlos (`sg.ejecutado_en is null` en el
 *  WHERE) ni reenvía el mensaje (además, `clientMessageId` determinístico por
 *  (solicitud, tipo) hace que un reintento del propio adaptador tampoco duplique el
 *  envío del lado del proveedor). */
export async function runGroupFollowUps(
  db: DbClient,
  params: RunGroupFollowUpsParams,
  opts: RunGroupFollowUpsOptions = {},
): Promise<RunGroupFollowUpsResult> {
  const now = (opts.now ?? (() => new Date()))();
  const messagingPort = opts.messagingPort ?? sharedWhatsappAdapter;
  const templateNameByType = opts.templateNameByType ?? DEFAULT_TEMPLATE_NAME_BY_TYPE;
  const languageCode = opts.languageCode ?? "es";

  const { rows } = await db.query<CandidateRow>(
    `select sg.id, sg.solicitud_id, sg.tipo, sg.programado_para::text as programado_para,
            sg.ejecutado_en::text as ejecutado_en,
            s.organizador_nombre, s.organizador_telefono
     from public.seguimiento_solicitud_grupo sg
     join public.solicitud_grupo s on s.id = sg.solicitud_id
     where s.hotel_id = $1
       and s.estado = 'pendiente'
       and sg.ejecutado_en is null
       and sg.programado_para <= $2
     order by sg.programado_para asc;`,
    [params.hotelId, now],
  );

  const candidatos: CandidateFollowUp[] = rows.map((r) => ({
    id: r.id,
    solicitudId: r.solicitud_id,
    tipo: r.tipo,
    programadoPara: new Date(r.programado_para),
    ejecutadoEn: r.ejecutado_en ? new Date(r.ejecutado_en) : null,
    organizadorNombre: r.organizador_nombre,
    organizadorTelefono: r.organizador_telefono,
  }));
  const due = selectDueGroupFollowUps(now, candidatos);

  const ejecutados: ExecutedGroupFollowUp[] = [];
  for (const followUp of due) {
    const sent = await messagingPort.sendTemplateMessage({
      to: followUp.organizadorTelefono,
      templateName: templateNameByType[followUp.tipo],
      languageCode,
      parameters: [followUp.organizadorNombre],
      // Determinístico por (solicitud, tipo): un reintento de este job sobre el MISMO
      // seguimiento (p. ej. si el proceso muere entre el envío y el UPDATE de abajo)
      // reutiliza la idempotencia interna del adaptador en vez de enviar el mensaje dos
      // veces -- mismo criterio que `SendTemplateMessageInput.clientMessageId` documenta.
      clientMessageId: `seguimiento-grupo-${followUp.solicitudId}-${followUp.tipo}`,
    });

    await db.query(
      `update public.seguimiento_solicitud_grupo
       set ejecutado_en = $1, resultado = $2::jsonb
       where id = $3;`,
      [
        now,
        JSON.stringify({
          externalMessageId: sent.externalMessageId,
          canal: "whatsapp",
          simulado: messagingPort.status().simulated,
        }),
        followUp.id,
      ],
    );

    await db.query(
      "select public.record_audit_log($1, $2, 'solicitud_grupo.seguimiento_enviado', 'solicitud_grupo', $3, $4);",
      [
        params.tenantId,
        params.hotelId,
        followUp.solicitudId,
        JSON.stringify({ tipo: followUp.tipo, seguimientoId: followUp.id, externalMessageId: sent.externalMessageId }),
      ],
    );

    ejecutados.push({
      seguimientoId: followUp.id,
      solicitudId: followUp.solicitudId,
      tipo: followUp.tipo,
      organizadorTelefono: followUp.organizadorTelefono,
      externalMessageId: sent.externalMessageId,
    });
  }

  return { ejecutados };
}
