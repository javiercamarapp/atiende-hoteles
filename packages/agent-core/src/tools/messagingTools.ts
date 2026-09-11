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

// REQ-HUE-021/REQ-SEG-007: "mensaje transaccional (utility) puede enviarse sin opt-in;
// mensaje de marketing es bloqueado si no existe opt-in registrado (fecha/canal/texto)
// previo al envío". El error se identifica por el prefijo del mensaje (mismo patrón que
// el resto de errores de dominio de este repo, ver apps/api/src/lib/errors.ts) para que
// CUALQUIER capa que llame a `tool.run()` -- la ruta directa (routes/mensajeria.ts), el
// AgentRunner en vivo, o la ejecución diferida de una aprobación
// (apps/api/src/lib/aprobacionEjecutor.ts) -- lo mapee al mismo 409, sin filtrar detalle
// interno.
export class MarketingOptInRequiredError extends Error {
  constructor(
    public readonly guestPhone: string,
    public readonly templateName: string,
  ) {
    super(
      `opt_in_marketing_requerido: no existe opt-in de marketing registrado (fecha/canal/texto) ` +
        `para ${guestPhone} -- la plantilla "${templateName}" está clasificada como marketing y ` +
        `no puede enviarse sin ese opt-in previo.`,
    );
    this.name = "MarketingOptInRequiredError";
  }
}

export interface MarketingOptInGateParams {
  readonly db: SqlClient;
  readonly hotelId: string;
  readonly templateName: string;
  readonly guestPhone: string;
}

/**
 * REQ-HUE-021/REQ-SEG-007: determina si ESTE envío está bloqueado por falta de opt-in de
 * marketing. Solo aplica a plantillas que el hotel clasificó explícitamente como
 * "marketing" (`hotel_messaging_config.marketing_templates`, migración 0099) --
 * cualquier otra plantilla (transaccional/utility, la mayoría por defecto) nunca exige
 * opt-in, sin importar si tiene consentimiento registrado o no.
 *
 * El opt-in se considera "vigente" cuando la fila `consent` MÁS RECIENTE (tabla e
 * infraestructura de la migración 0068 -- fecha=`created_at`, canal=`channel`,
 * texto=`aviso_version`) con `channel='whatsapp'` y `consent_kind='marketing'` para el
 * HUÉSPED dueño de ese teléfono en este hotel tiene `granted=true`. Sin ningún huésped
 * identificable por ese teléfono, o sin ninguna fila, el envío se trata como "sin
 * opt-in" (deny-by-default): nunca se asume consentimiento por ausencia de dato.
 *
 * REQ-HUE-024 (fix real encontrado al construir `consentLedger.ts`/
 * `apps/api/src/routes/consentimiento.ts`, ver `tests/adversarial/consent-ledger.spec.ts`
 * caso "opt-out posterior"): la versión anterior de este chequeo era
 * `exists(... granted = true)` -- "¿alguna vez otorgó consentimiento?" -- en vez de "¿la
 * decisión MÁS RECIENTE fue otorgar?". Eso significaba que un huésped que otorgó
 * consentimiento una vez y luego se dio de BAJA (una fila `granted=false` posterior,
 * exactamente lo que REQ-HUE-020 exige registrar) seguía recibiendo marketing: la fila
 * antigua `granted=true` seguía satisfaciendo el `EXISTS`, sin importar cuántas bajas
 * vinieran después. `order by created_at desc limit 1` hace que la decisión más
 * reciente sea la única que cuenta -- el criterio que un huésped esperaría de un botón
 * de "darte de baja".
 */
export async function isMarketingSendBlocked(params: MarketingOptInGateParams): Promise<boolean> {
  const { rows: configRows } = await params.db.query<{ marketing_templates: string[] }>(
    "select marketing_templates from public.hotel_messaging_config where hotel_id = $1;",
    [params.hotelId],
  );
  const marketingTemplates = configRows[0]?.marketing_templates ?? [];
  if (!marketingTemplates.includes(params.templateName)) return false;

  const { rows: optInRows } = await params.db.query<{ granted: boolean }>(
    `select co.granted
     from public.consent co
     join public.guest g on g.id = co.guest_id
     where co.hotel_id = $1
       and g.phone = $2
       and co.channel = 'whatsapp'
       and co.consent_kind = 'marketing'
     order by co.created_at desc
     limit 1;`,
    [params.hotelId, params.guestPhone],
  );
  return !(optInRows[0]?.granted ?? false);
}

// REQ-RES-018: "sin contactar antes por un canal ajeno a la plataforma de la OTA" --
// error gemelo de `MarketingOptInRequiredError` (mismo criterio: identificable por
// prefijo, para que CUALQUIER capa que llame a `tool.run()` lo mapee al mismo 409, sin
// filtrar detalle interno).
export class OtaContactoEnmascaradoError extends Error {
  constructor(public readonly guestPhone: string) {
    super(
      `contacto_enmascarado_por_ota: ${guestPhone} pertenece a una reserva cuyo contacto sigue siendo el relay ` +
        `enmascarado de una OTA -- no puede contactarse por WhatsApp (canal ajeno a la OTA) hasta que el huésped ` +
        `comparta su contacto real (típicamente al completar el check-in online, ver REQ-RES-018).`,
    );
    this.name = "OtaContactoEnmascaradoError";
  }
}

export interface OtaMaskedContactGateParams {
  readonly db: SqlClient;
  readonly hotelId: string;
  readonly guestPhone: string;
}

/**
 * REQ-RES-018: determina si ESTE envío de WhatsApp está bloqueado porque el destinatario
 * es hoy el relay enmascarado de una OTA, no el huésped real. Equivalente exacto (mismo
 * criterio, sin poder importar `@atiende-hoteles/domain-hotel` -- agent-core es núcleo
 * puro sin esa dependencia, ver comentario de `getMarketingTemplateBody`) de
 * `esContactoEnmascaradoPorOta()`/`packages/domain-hotel/src/reservas/
 * contactoOtaEnmascarado.ts`: `channel != 'directo'` Y `guest_contact_masked_by_ota =
 * true` para ALGUNA reserva del huésped dueño de `guestPhone` en este hotel. Sin ningún
 * huésped identificable por ese teléfono, o sin ninguna reserva enmascarada, el envío NO
 * se bloquea por este motivo (deny únicamente cuando el dato positivamente lo confirma --
 * a diferencia del opt-in de marketing, aquí "no encontrado" no es el caso peligroso: un
 * teléfono que no pertenece a ninguna reserva enmascarada es, por definición, un contacto
 * directo real u otro huésped, nunca el relay de una OTA).
 */
export async function isGuestContactMaskedByOta(params: OtaMaskedContactGateParams): Promise<boolean> {
  const { rows } = await params.db.query<{ masked: boolean }>(
    `select exists (
       select 1
       from public.reservation r
       join public.guest g on g.id = r.guest_id
       where r.hotel_id = $1
         and g.phone = $2
         and r.channel <> 'directo'
         and r.guest_contact_masked_by_ota = true
     ) as masked;`,
    [params.hotelId, params.guestPhone],
  );
  return rows[0]?.masked ?? false;
}

export interface MarketingTemplateBodyParams {
  readonly db: SqlClient;
  readonly hotelId: string;
  readonly templateName: string;
}

/**
 * REQ-SEG-007: "todo mensaje de marketing incluye opción de baja". Si `templateName`
 * está clasificada como marketing y tiene un texto registrado
 * (`hotel_messaging_config.marketing_template_bodies`, migración 0111), devuelve ese
 * texto -- validado por `lintMarketingTemplateBody()` (packages/domain-hotel) ANTES de
 * poder guardarse, ver `PATCH .../mensajeria/config` -- para que el mensaje REALMENTE
 * enviado use ese contenido (con su opción de baja) en vez del resumen genérico
 * `[plantilla:...] parámetros` que usa cualquier plantilla transaccional/utility. `null`
 * para cualquier plantilla no clasificada como marketing, o (no debería ocurrir: la ruta
 * de configuración lo exige) clasificada como marketing pero sin texto registrado --
 * esta función nunca inventa un texto por su cuenta.
 *
 * agent-core sigue sin depender de `@atiende-hoteles/domain-hotel` (ver comentario de
 * archivo, "núcleo puro sin dependencias"): el LINTER vive y corre en la capa de API al
 * guardar la configuración; aquí solo se LEE el texto ya validado.
 */
export async function getMarketingTemplateBody(params: MarketingTemplateBodyParams): Promise<string | null> {
  const { rows } = await params.db.query<{
    marketing_templates: string[];
    marketing_template_bodies: Record<string, string>;
  }>(
    "select marketing_templates, marketing_template_bodies from public.hotel_messaging_config where hotel_id = $1;",
    [params.hotelId],
  );
  const row = rows[0];
  if (!row || !row.marketing_templates.includes(params.templateName)) return null;
  return row.marketing_template_bodies[params.templateName] ?? null;
}

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
      // REQ-RES-018: gate de contacto-enmascarado-por-OTA ANTES que cualquier otra cosa
      // (incluido el gate de opt-in de abajo) -- ni una fila en `conversation`/`message`
      // ni una llamada a `deps.messaging.sendTemplateMessage` mientras el destinatario
      // siga siendo el relay de una OTA, sin importar qué capa haya invocado esta tool
      // (ruta directa, AgentRunner, o ejecución diferida de una aprobación).
      if (await isGuestContactMaskedByOta({ db: deps.db, hotelId: ctx.hotelId, guestPhone: input.guestPhone })) {
        throw new OtaContactoEnmascaradoError(input.guestPhone);
      }

      // REQ-HUE-021/REQ-SEG-007: gate de opt-in ANTES de tocar `conversation`/`message`
      // o llamar al adaptador de mensajería -- ningún envío de marketing sin opt-in dara
      // como resultado NI UNA fila en `message` ni una llamada a
      // `deps.messaging.sendTemplateMessage`, sin importar qué capa haya invocado esta
      // tool (ver comentario de `MarketingOptInRequiredError`).
      if (
        await isMarketingSendBlocked({
          db: deps.db,
          hotelId: ctx.hotelId,
          templateName: input.templateName,
          guestPhone: input.guestPhone,
        })
      ) {
        throw new MarketingOptInRequiredError(input.guestPhone, input.templateName);
      }

      const { rows: conversationRows } = await deps.db.query<{ id: string }>(
        `insert into public.conversation (tenant_id, hotel_id, channel, guest_phone)
         values ($1, $2, 'whatsapp', $3)
         on conflict (hotel_id, channel, guest_phone) where guest_phone is not null
         do update set updated_at = now()
         returning id;`,
        [ctx.orgId, ctx.hotelId, input.guestPhone],
      );
      const conversationId = conversationRows[0]!.id;

      // REQ-SEG-007: si esta plantilla es de marketing, el CUERPO REAL guardado (lo que
      // el huésped recibió) es el texto que pasó el linter al configurarse -- nunca el
      // resumen genérico `[plantilla:...] parámetros` -- así el mensaje persistido
      // demuestra por sí mismo que incluyó la opción de baja, sin depender de leer la
      // configuración por separado para auditarlo.
      const marketingBody = await getMarketingTemplateBody({
        db: deps.db,
        hotelId: ctx.hotelId,
        templateName: input.templateName,
      });

      const clientMessageId = `${ctx.requestId}:${input.templateName}:${randomUUID()}`;
      const sent = await deps.messaging.sendTemplateMessage({
        to: input.guestPhone,
        templateName: input.templateName,
        languageCode: input.languageCode,
        parameters: input.parameters,
        clientMessageId,
      });

      const messageBody = marketingBody
        ? input.parameters.length > 0
          ? `${marketingBody} — ${input.parameters.join(" | ")}`
          : marketingBody
        : `[plantilla:${input.templateName}] ${input.parameters.join(" | ")}`.trim();

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
          messageBody,
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
  /** T2 (auditoria-2 tool-calling CRÍTICO): quién/qué generó la solicitud
   * (`RequestApprovalParams.requestedBy`) -- necesario para verificar que, cuando la
   * pidió un AGENTE, el destinatario sea el huésped de la conversación en curso y no
   * uno que el modelo eligió libremente. */
  readonly requestedBy: string;
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
        requestedBy: params.requestedBy,
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

// T2 (auditoria-2 tool-calling CRÍTICO): `runner.ts` codifica el TIPO de actor en
// `requestedBy` (`agent:<agentName>:<actorType>:<actorId>`) -- cuando `actorType` es
// "guest", `actorId` es el telefono del huesped de ESA conversacion (unica fuente de
// verdad de "a quien le esta hablando el agente ahora", nunca lo que el modelo ponga
// en el input de la tool).
const AGENT_GUEST_REQUESTED_BY_RE = /^agent:[^:]+:guest:(.+)$/;

/** Helper de wiring: construye el `isTransactional` para
 * `createTransactionalTemplateApprovalQueue` a partir de la config real del hotel
 * (`hotel_messaging_config.transactional_templates`), solo para la tool de WhatsApp --
 * cualquier otra tool (p.ej. `autorizar_gasto_mantenimiento`) nunca se auto-aprueba aqui.
 *
 * T2: cuando la solicitud la generó un AGENTE, el destinatario (`input.guestPhone`)
 * DEBE coincidir exactamente con el huésped de la conversación en curso -- el modelo
 * puede elegir la plantilla (de la lista permitida) pero NUNCA el destinatario. Un
 * agente invocado sin huésped vinculado (p.ej. prueba operativa de staff) o cuyo
 * `guestPhone` no coincide con el de la conversación NUNCA se auto-aprueba, sin
 * importar que la plantilla esté en la lista -- cae al flujo normal de aprobación
 * humana. Un envío directo de un STAFF (`requestedBy` "staff:...", panel de
 * mensajería) no cambia: el humano ya eligió el destinatario al escribirlo. */
export function transactionalTemplateCheckFromDb(db: SqlClient): TransactionalTemplateCheck {
  return async ({ hotelId, toolName, input, requestedBy }) => {
    if (toolName !== SEND_WHATSAPP_TEMPLATE_TOOL_NAME) return false;
    const templateName = (input as { templateName?: unknown } | null)?.templateName;
    if (typeof templateName !== "string") return false;

    if (requestedBy.startsWith("agent:")) {
      const guestMatch = AGENT_GUEST_REQUESTED_BY_RE.exec(requestedBy);
      const guestPhone = (input as { guestPhone?: unknown } | null)?.guestPhone;
      if (!guestMatch || typeof guestPhone !== "string" || guestPhone !== guestMatch[1]) {
        return false;
      }
    }

    const { rows } = await db.query<{ transactional_templates: string[] }>(
      "select transactional_templates from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    const allowed = rows[0]?.transactional_templates ?? [];
    return allowed.includes(templateName);
  };
}
