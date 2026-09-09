// H6b-notif · Notificación ACTIVA por WhatsApp al crear un `housekeeping_task`/
// `maintenance_ticket`/`guest_ticket` -- hallazgo de auditoría: hasta ahora la ÚNICA
// forma de enterarse de una tarea/ticket nueva era el tablero de staff
// (apps/api/src/routes/housekeeping.ts, ~58-95), sin ningún push/WhatsApp/email
// disparado al crearla.
//
// Investigación previa (para no inventar un modelo nuevo de staff/turnos):
//   - Destinatario: `public.hotel_staff.role` (8 roles reales, migración 0003) +
//     `public.staff_user.whatsapp_phone` (E.164, migración 0053 -- ya existe y ya se usa
//     para resolver el actor de un botón de aprobación de WhatsApp entrante,
//     routes/aprobacionesWhatsapp.ts). Ninguna columna nueva.
//   - `public.staff_schedule` (migración 0117) SÍ existe, pero es horario programado
//     para cumplimiento laboral (LFT art.132 fr.XXXIV, cruce contra asistencia real) --
//     no un directorio de "quién está de turno ahora mismo" pensado para enrutar
//     notificaciones, y su RLS (self-or-owner/gm) tampoco lo permitiría desde el actor
//     que crea la tarea (p.ej. frontdesk). Deliberadamente NO se usa aquí.
//
// Una sola función reutilizable (no una tool de agente aparte), invocada desde el
// `run()` de las tres tools de creación reales (housekeepingTools.ts/ticketTools.ts) en
// vez de repetirse en cada ruta HTTP:
//   1) El MISMO camino -- panel de staff (HTTP directo), `AgentRunner` (conversacional),
//      o una llamada directa como la escalación de menor no acompañado
//      (routes/agentes.ts) -- dispara la misma notificación sin duplicar la lógica.
//   2) El gate "shadow" del agente (runner.ts: ninguna tool write/external/money
//      EJECUTA en shadow, se detiene ANTES de llamar a `run()`) se respeta solo:
//      si `run()` nunca corre, esta función tampoco -- sin necesitar lógica de gate
//      propia aquí. Una acción de STAFF real (panel web) sí notifica siempre, sin
//      importar el gate del agente: el gate gobierna autonomía del agente, no al staff.
//   3) El adaptador de mensajería que reciba (`deps.messaging`) ya trae su propio gate
//      real/simulado resuelto por credenciales (`resolveWhatsappAdapter()`,
//      lib/messaging.ts): con credenciales de Meta ausentes se usa el
//      `FakeWhatsappAdapter` y NINGÚN envío toca la red real -- esta función nunca
//      decide eso por su cuenta, solo llama a `deps.messaging.sendTemplateMessage()`.
import type { StaffRole } from "../context.ts";
import type { SqlClient } from "../sql.ts";
import type { WhatsappSenderLike } from "./messagingTools.ts";

export interface StaffNotifyDeps {
  readonly db: SqlClient;
  /** Adaptador real/simulado de WhatsApp -- ausente (`undefined`): esta función no
   *  intenta notificar nada (mismo criterio honesto que "sin_pos_configurado" en
   *  fraudScan.ts, nunca una notificación fabricada). */
  readonly messaging?: WhatsappSenderLike;
  /** `true` mientras `messaging` sea el adaptador simulado -- solo informativo, se
   *  refleja en el resultado para que el llamador lo pueda auditar/mostrar. */
  readonly simulated?: boolean;
}

export interface NotifyStaffOfTaskParams {
  readonly hotelId: string;
  /** `staff_user.id` YA asignado a la tarea/ticket, si lo hay -- tiene prioridad sobre
   *  `role`. Hoy ninguna de las tres tools de creación asigna al crear (`assigned_to`
   *  nace `null`, se asigna después vía PATCH), así que en la práctica esto siempre cae
   *  al camino de rol/departamento -- el parámetro queda explícito para no tener que
   *  tocar esta función el día que una creación sí traiga un responsable ya asignado. */
  readonly assignedTo?: string | null;
  /** Rol/departamento responsable cuando no hay (o no sirve) un asignado todavía. */
  readonly role: StaffRole;
  readonly templateName: string;
  readonly languageCode?: string;
  readonly parameters: readonly string[];
  /** Identificador de negocio de la tarea/ticket (taskId/ticketId) -- hace
   *  determinista el `clientMessageId` por (entidad, destinatario): reintentar esta
   *  función sobre la MISMA fila nunca duplica el envío (mismo criterio de idempotencia
   *  por `clientMessageId` que ya usa `enviar_mensaje_whatsapp_plantilla`). */
  readonly dedupeKey: string;
}

export interface NotifiedStaffRecipient {
  readonly staffId: string;
  readonly whatsappPhone: string;
  readonly externalMessageId: string;
}

export interface NotifyStaffOfTaskResult {
  readonly attempted: boolean;
  readonly simulated: boolean;
  readonly recipients: readonly NotifiedStaffRecipient[];
  /** Motivo honesto de por qué `recipients` quedó vacío. */
  readonly reason?: "sin_adaptador_configurado" | "sin_destinatarios_con_whatsapp";
}

interface StaffPhoneRow {
  id: string;
  whatsapp_phone: string;
}

/**
 * Notifica por WhatsApp (plantilla) al staff responsable de una tarea/ticket recién
 * creado -- ver comentario de archivo para el criterio de destinatario y de gate.
 *
 * "Best effort": esta función NUNCA lanza por un fallo de mensajería (adaptador caído,
 * límite de tier) -- para cuando corre, la tarea/ticket YA existe en la base; un envío
 * fallido queda fuera de `recipients`, nunca revierte ni bloquea la creación real.
 */
export async function notifyStaffOfNewTask(
  deps: StaffNotifyDeps,
  params: NotifyStaffOfTaskParams,
): Promise<NotifyStaffOfTaskResult> {
  const simulated = deps.simulated ?? false;
  if (!deps.messaging) {
    return { attempted: false, simulated, recipients: [], reason: "sin_adaptador_configurado" };
  }
  const messaging = deps.messaging;

  // `staff_user.whatsapp_phone` NUNCA es seleccionable con la sesión normal de un staff
  // (migración 0011: el SELECT de fila completa de 0010 quedó revocado y reemplazado
  // por uno acotado a columnas que deliberadamente NO incluye `whatsapp_phone`) -- la
  // única vía es `staff_notify_recipients()` (SECURITY DEFINER, migración 0127), que
  // valida la membresía del actor antes de devolver cualquier teléfono. Ver comentario
  // de archivo de esa migración.
  const { rows: recipientRows } = await deps.db.query<StaffPhoneRow>(
    "select id, whatsapp_phone from public.staff_notify_recipients($1, $2, $3);",
    [params.hotelId, params.role, params.assignedTo ?? null],
  );

  if (recipientRows.length === 0) {
    return { attempted: true, simulated, recipients: [], reason: "sin_destinatarios_con_whatsapp" };
  }

  const recipients: NotifiedStaffRecipient[] = [];
  for (const row of recipientRows) {
    try {
      const sent = await messaging.sendTemplateMessage({
        to: row.whatsapp_phone,
        templateName: params.templateName,
        languageCode: params.languageCode ?? "es_MX",
        parameters: [...params.parameters],
        clientMessageId: `staff-notif:${params.dedupeKey}:${row.id}`,
      });
      recipients.push({ staffId: row.id, whatsappPhone: row.whatsapp_phone, externalMessageId: sent.externalMessageId });
    } catch {
      // Best effort (ver comentario de función): un fallo de ESTE destinatario no
      // detiene a los demás ni a la operación que disparó la notificación.
    }
  }

  return { attempted: true, simulated, recipients };
}
