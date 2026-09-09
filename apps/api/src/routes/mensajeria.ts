// H6b · /hoteles/:hotelId/mensajeria — bandeja de conversaciones de WhatsApp por huésped
// (REQ-HUE-001/002, REQ-HK-002/013/021, H09) sobre `MessagingPort`
// (packages/mcp-servers/whatsapp): SIEMPRE `FakeWhatsappAdapter` en este hito (sin
// credenciales de Meta, ADR-007 "PENDIENTE DE CREDENCIALES"), nunca una llamada real.
// Enviar una plantilla reutiliza la MISMA tool de dominio de agent-core
// (`enviar_mensaje_whatsapp_plantilla`); las plantillas transaccionales configuradas por
// hotel (`hotel_messaging_config.transactional_templates`) se auto-aprueban sin espera
// humana (`createTransactionalTemplateApprovalQueue`), cualquier otra queda pendiente en
// `agent_approval` hasta que routes/aprobaciones.ts la decida.
//
// El webhook de entrada (`POST /hoteles/:hotelId/mensajeria/webhook`) es PUBLICO (Meta no
// manda un Bearer de staff): la autorización es la firma HMAC del cuerpo crudo contra el
// `webhook_secret` del hotel, mismo criterio de "sin sesión de staff, cliente admin" que
// `routes/cancelacionPublica.ts`. Idempotencia por `event_id` vía `idempotency_key`
// (0009/0011): un replay del MISMO evento nunca reprocesa ni duplica un mensaje.
//
// REQ-HUE-021/REQ-SEG-007: las plantillas que el hotel clasifica como marketing
// (`hotel_messaging_config.marketing_templates`, migración 0099) exigen opt-in previo
// registrado (`consent`, migración 0068 -- fecha/canal/texto) para el huésped
// destinatario; sin esa fila, el envío se rechaza (409) ANTES de crear la solicitud de
// aprobación, y `enviar_mensaje_whatsapp_plantilla.run()` repite el mismo chequeo como
// defensa en profundidad para cualquier otra vía de ejecución (`isMarketingSendBlocked`,
// packages/agent-core). Cualquier plantilla transaccional/utility (la mayoría, incluidas
// las que NO están en `transactional_templates`) nunca requiere opt-in.
//
// REQ-SEG-007 (segunda mitad): "todo mensaje de marketing incluye opción de baja",
// verificado con "mensaje sin opción de baja -> rechazado por el linter de plantillas".
// `PATCH .../mensajeria/config` exige un texto (`textosPlantillasMarketing`) para TODA
// plantilla que termine en `marketing_templates` y lo valida con
// `lintMarketingTemplateBody()` (packages/domain-hotel, migración 0111) ANTES de
// guardar -- un texto sin opción de baja reconocible rechaza el PATCH completo (400),
// nunca deja la plantilla "clasificada" a medias. El envío real reutiliza ese mismo
// texto ya verificado como cuerpo del mensaje persistido (`getMarketingTemplateBody`,
// packages/agent-core), así el propio `message.body` guardado demuestra que incluyó la
// opción de baja.
//
// REQ-HUE-006/GOB-034 (disclosure de IA): este webhook es el ÚNICO punto real de este
// repo que procesa un mensaje entrante de huésped, así que es donde vive la detección
// de "primer turno" del disclosure engine (agent-core `disclosure.ts`) -- 0 mensajes
// previos en `public.message` para la conversación dispara el disclosure de IA antes
// de cualquier otra respuesta automática; independientemente del turno, una pregunta
// tipo "¿eres humano?" recibe la respuesta FIJA no generativa del mismo módulo.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
  buildToolContext,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  isMarketingSendBlocked,
  esPreguntaSiEsHumano,
  PostgresApprovalQueue,
  RESPUESTA_FIJA_ES_HUMANO,
  transactionalTemplateCheckFromDb,
  WHATSAPP_DISCLOSURE_MESSAGE,
  type SendWhatsappTemplateInput,
} from "@atiende-hoteles/agent-core";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { WebhookReplayError, WebhookSignatureError } from "@atiende-hoteles/mcp-shared";
import {
  detectAndRedactPaymentData,
  lintMarketingTemplateBody,
  looksLikeCheckinDataInFreeText,
} from "@atiende-hoteles/domain-hotel";
import { sharedWhatsappAdapter } from "../lib/messaging.ts";
import type { DbClient } from "@atiende-hoteles/db";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const enviarSchema = z.object({
  guestPhone: z.string().trim().min(8).max(20),
  templateName: z.string().trim().min(1).max(60),
  languageCode: z.string().trim().min(2).max(10).default("es"),
  parameters: z.array(z.string().trim().max(200)).max(10).default([]),
});

interface ConversationRow {
  id: string;
  guest_name: string | null;
  guest_phone: string | null;
  channel: string;
  last_body: string | null;
  last_message_at: string | null;
}

interface MessageRow {
  id: string;
  direction: string;
  channel: string;
  template_name: string | null;
  body: string;
  delivery_status: string | null;
  simulated: boolean;
  created_at: string;
  contiene_dato_sensible: boolean;
}

/** Config de mensajería del hotel (secreto de webhook simulado + plantillas
 * transaccionales). Se crea perezosamente con valores por defecto seguros la primera vez
 * que el hotel usa mensajería -- ningún gerente necesita un paso de setup previo para que
 * la bandeja funcione, y puede ajustar las plantillas transaccionales después. */
interface MessagingConfig {
  webhookSecret: string;
  transactionalTemplates: string[];
  /** REQ-HUE-021/REQ-SEG-007: plantillas clasificadas como marketing/promocional --
   *  enviarlas exige opt-in previo registrado (ver `isMarketingSendBlocked`). */
  marketingTemplates: string[];
  /** REQ-SEG-007: texto real de cada plantilla de marketing (indexado por nombre),
   *  validado por `lintMarketingTemplateBody()` antes de guardarse -- ver PATCH abajo. */
  marketingTemplateBodies: Record<string, string>;
}

interface MessagingConfigRow {
  webhook_secret: string;
  transactional_templates: string[];
  marketing_templates: string[];
  marketing_template_bodies: Record<string, string>;
}

const MESSAGING_CONFIG_SELECT =
  "select webhook_secret, transactional_templates, marketing_templates, marketing_template_bodies from public.hotel_messaging_config where hotel_id = $1;";

function toMessagingConfig(row: MessagingConfigRow): MessagingConfig {
  return {
    webhookSecret: row.webhook_secret,
    transactionalTemplates: row.transactional_templates,
    marketingTemplates: row.marketing_templates,
    marketingTemplateBodies: row.marketing_template_bodies,
  };
}

async function ensureMessagingConfig(db: DbClient, hotelId: string, orgId: string): Promise<MessagingConfig> {
  const { rows } = await db.query<MessagingConfigRow>(MESSAGING_CONFIG_SELECT, [hotelId]);
  if (rows[0]) return toMessagingConfig(rows[0]);

  const webhookSecret = randomUUID();
  await db.query(
    `insert into public.hotel_messaging_config (hotel_id, tenant_id, webhook_secret)
     values ($1, $2, $3)
     on conflict (hotel_id) do nothing;`,
    [hotelId, orgId, webhookSecret],
  );
  const { rows: after } = await db.query<MessagingConfigRow>(MESSAGING_CONFIG_SELECT, [hotelId]);
  return toMessagingConfig(after[0]!);
}

export function mensajeriaRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // Webhook PUBLICO: sin authMiddleware/dbSession de staff a propósito (ver comentario de
  // archivo). Se registra ANTES del bloque `app.use` de abajo para que ese middleware
  // (que exige Bearer de staff) nunca intercepte esta ruta.
  app.post("/hoteles/:hotelId/mensajeria/webhook", async (c) => {
    const hotelId = c.req.param("hotelId");
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? c.req.header("x-webhook-signature");

    const { rows: configRows } = await deps.engine.admin.query<{
      webhook_secret: string;
      tenant_id: string;
    }>("select webhook_secret, tenant_id from public.hotel_messaging_config where hotel_id = $1;", [hotelId]);
    if (!configRows[0]) throw Errors.notFound("Este hotel no tiene mensajería configurada.");

    const adapter = new FakeWhatsappAdapter(undefined, undefined, configRows[0].webhook_secret);
    let event;
    try {
      event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureError) throw Errors.unauthorized("Firma de webhook inválida.");
      if (err instanceof WebhookReplayError) return c.json({ estado: "duplicado" }, 200);
      throw err;
    }

    // Idempotencia PERSISTENTE por event_id (0009/0011 idempotency_key): sobrevive entre
    // peticiones distintas, a diferencia del `InMemoryReplayGuard` del adaptador (que solo
    // protege dentro de UNA misma instancia -- aquí se crea una por request).
    const claim = await deps.engine.admin.query<{ id: string }>(
      `insert into public.idempotency_key (tenant_id, scope, key)
       values ($1, 'whatsapp.webhook', $2)
       on conflict (tenant_id, scope, key) do nothing
       returning id;`,
      [configRows[0].tenant_id, event.eventId],
    );
    if (claim.rows.length === 0) {
      return c.json({ estado: "duplicado" }, 200);
    }

    if (event.type === "message.received" && event.from) {
      const { rows: convRows } = await deps.engine.admin.query<{ id: string }>(
        `insert into public.conversation (tenant_id, hotel_id, channel, guest_phone)
         values ($1, $2, 'whatsapp', $3)
         on conflict (hotel_id, channel, guest_phone) where guest_phone is not null
         do update set updated_at = now()
         returning id;`,
        [configRows[0].tenant_id, hotelId, event.from],
      );

      // REQ-HUE-006/GOB-034 (disclosure engine, agent-core disclosure.ts): "primer
      // turno" de ESTA conversación se decide aquí, en el ÚNICO punto real de entrada
      // de un mensaje de WhatsApp (antes de insertar el mensaje entrante actual) --
      // 0 mensajes previos en `public.message` para esta `conversation_id` es la señal
      // (la capa de sesión que agent-core README.md §8 dejaba pendiente). Antes de este
      // fix, nada en apps/api llamaba a este disclosure engine: `AgentRunner`
      // (runner.ts) SÍ antepone `disclosureMessage` cuando `ctx.isFirstTurn===true`,
      // pero el único punto real de construcción de `AgentRunner`
      // (routes/agentes.ts) nunca invoca al huésped por WhatsApp, y este webhook --el
      // único código que procesa un mensaje entrante real-- nunca llamaba a
      // `AgentRunner` ni fijaba `isFirstTurn`: el disclosure quedaba implementado pero
      // desconectado del flujo real, igual que REQ-AB-004 antes de conectar su tool.
      const { rows: previosRows } = await deps.engine.admin.query<{ count: string }>(
        `select count(*)::text as count from public.message where conversation_id = $1;`,
        [convRows[0]!.id],
      );
      const esPrimerTurno = Number(previosRows[0]?.count ?? 0) === 0;

      // L-tarjeta (auditoria-2 legal CRÍTICO, REQ-HUE-010/H09-027): un huésped
      // confundido puede escribir su número de tarjeta por WhatsApp -- se detecta
      // (Luhn real) y se guarda SIEMPRE la versión redactada, nunca el dato crudo, sin
      // importar qué rol lea después este mensaje (`GET .../mensajes` no filtra por
      // rol, ver hallazgo original). `contiene_dato_sensible` deja la señal explícita
      // para el panel/reportes de cumplimiento sin tener que re-detectar sobre texto
      // ya redactado.
      const pago = detectAndRedactPaymentData(event.textBody);
      const bodyParaGuardar = event.textBody ? pago.redactedText : "(mensaje sin texto)";
      await deps.engine.admin.query(
        `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, body, external_message_id, delivery_status, simulated, contiene_dato_sensible)
         values ($1, $2, $3, 'entrante', 'whatsapp', $4, $5, 'entregado', true, $6);`,
        [configRows[0].tenant_id, hotelId, convRows[0]!.id, bodyParaGuardar, event.externalMessageId ?? null, pago.containsSensitiveData],
      );

      // REQ-HUE-006: disclosure de IA en el PRIMER mensaje del hilo -- se envía antes
      // de cualquier otra respuesta automática (tarjeta/check-in de abajo) para que sea
      // lo primero que el huésped recibe de vuelta en la conversación.
      if (esPrimerTurno) {
        const disclosure = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "disclosure_ia",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `disclosure-ia-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'disclosure_ia', $4, $5, $6, true);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, WHATSAPP_DISCLOSURE_MESSAGE, disclosure.externalMessageId, disclosure.status],
        );
      }

      // REQ-HUE-006: respuesta FIJA (no generativa) a "¿eres humano?" y variantes --
      // independiente de si es el primer turno, se aplica en cualquier punto de la
      // conversación en que el huésped pregunte directamente.
      if (esPreguntaSiEsHumano(event.textBody)) {
        const respuesta = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "respuesta_es_humano",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `es-humano-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'respuesta_es_humano', $4, $5, $6, true);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, RESPUESTA_FIJA_ES_HUMANO, respuesta.externalMessageId, respuesta.status],
        );
      }

      if (pago.containsCardNumber) {
        const aviso = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "pago_seguro_enlace",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `pago-seguro-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'pago_seguro_enlace',
                   'Por tu seguridad, nunca compartas tu tarjeta por chat: te compartimos un enlace de pago seguro.',
                   $4, $5, true);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, aviso.externalMessageId, aviso.status],
        );
      }

      // REQ-RES-016: "un intento de completar el check-in por chat libre es rechazado
      // y redirigido al flujo estructurado." Ningún código de este repo EXTRAE
      // identidad de texto de chat (la única vía real es
      // complete_checkin_public()/register_identity_document(), migraciones 0051/0054)
      // -- esto es la capa de UX que avisa pronto, enviando el enlace estructurado en
      // vez de dejar al huésped pensando que su mensaje sirvió para algo.
      if (looksLikeCheckinDataInFreeText(event.textBody)) {
        const redirect = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "checkin_enlace_estructurado",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `checkin-redirect-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'checkin_enlace_estructurado',
                   'Por seguridad, tu check-in no puede completarse por chat: te compartimos un enlace seguro de un solo uso.',
                   $4, $5, true);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, redirect.externalMessageId, redirect.status],
        );
      }
    } else if (event.type === "message.status_updated" && event.externalMessageId) {
      await deps.engine.admin.query(
        "update public.message set delivery_status = $1 where hotel_id = $2 and external_message_id = $3;",
        [event.status ?? "enviado", hotelId, event.externalMessageId],
      );
    }

    return c.json({ estado: "procesado" }, 200);
  });

  // Patrones EXACTOS (nunca un comodín "/*"): el webhook público de arriba vive bajo el
  // mismo prefijo "/mensajeria" y jamás debe quedar atrapado por este middleware de
  // sesión de staff -- listar cada subruta protegida explícitamente evita la ambigüedad
  // de un comodín que agrupe sin querer la ruta pública.
  for (const pattern of [
    "/hoteles/:hotelId/mensajeria",
    "/hoteles/:hotelId/mensajeria/mensajes",
    "/hoteles/:hotelId/mensajeria/config",
    "/hoteles/:hotelId/mensajeria/:conversationId/mensajes",
  ]) {
    app.use(pattern, authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  }

  app.get("/hoteles/:hotelId/mensajeria", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<ConversationRow>(
      `select conv.id, g.full_name as guest_name, conv.guest_phone, conv.channel::text as channel,
              m.body as last_body, conv.last_message_at::text as last_message_at
       from public.conversation conv
       left join public.guest g on g.id = conv.guest_id
       left join lateral (
         select body from public.message where conversation_id = conv.id order by created_at desc limit 1
       ) m on true
       where conv.hotel_id = $1
       order by coalesce(conv.last_message_at, conv.created_at) desc
       limit 100;`,
      [c.req.param("hotelId")],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        huesped: r.guest_name ?? r.guest_phone ?? "Sin identificar",
        canal: r.channel,
        ultimoMensaje: r.last_body ?? "(sin mensajes)",
        hace: r.last_message_at,
        // No hay correlación por-conversación de "solicitud de aprobación pendiente" en
        // este hito (una plantilla no transaccional se queda en agent_approval hasta que
        // /aprobaciones la decida, sin insertar un mensaje "fantasma" en el hilo) -- la
        // señal real de pendientes vive en la bandeja de aprobaciones, no aquí.
        requiereAprobacion: false,
      })),
    );
  });

  app.get("/hoteles/:hotelId/mensajeria/:conversationId/mensajes", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<MessageRow>(
      `select id, direction::text as direction, channel::text as channel, template_name, body,
              delivery_status::text as delivery_status, simulated, created_at::text as created_at,
              contiene_dato_sensible
       from public.message
       where conversation_id = $1 and hotel_id = $2
       order by created_at asc;`,
      [c.req.param("conversationId"), c.req.param("hotelId")],
    );
    return c.json(
      rows.map((m) => ({
        id: m.id,
        direccion: m.direction,
        canal: m.channel,
        plantilla: m.template_name,
        texto: m.body,
        estadoEntrega: m.delivery_status,
        simulado: m.simulated,
        creadoEn: m.created_at,
        contieneDatoSensible: m.contiene_dato_sensible,
      })),
    );
  });

  app.get("/hoteles/:hotelId/mensajeria/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const config = await ensureMessagingConfig(db, c.req.param("hotelId"), c.get("orgId"));
    return c.json({
      plantillasTransaccionales: config.transactionalTemplates,
      plantillasMarketing: config.marketingTemplates,
      textosPlantillasMarketing: config.marketingTemplateBodies,
    });
  });

  // REQ-HUE-021/REQ-SEG-007: `plantillasMarketing` es OPCIONAL en el PATCH (no
  // reemplaza la lista de marketing si el llamador solo quiere tocar las
  // transaccionales, o viceversa) -- una plantilla nunca puede quedar en AMBAS listas a
  // la vez (una plantilla transaccional/utility, por definición, no exige opt-in).
  // `textosPlantillasMarketing` (REQ-SEG-007) es el texto REAL de cada plantilla de
  // marketing (mapa nombre -> texto) -- también opcional (se mezcla con lo ya guardado,
  // nunca lo reemplaza entero), pero toda plantilla que termine en `plantillasMarketing`
  // debe tener, al final del merge, un texto que pase `lintMarketingTemplateBody()`.
  const configSchema = z
    .object({
      plantillasTransaccionales: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      plantillasMarketing: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      textosPlantillasMarketing: z.record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(1000)).optional(),
    })
    .refine(
      (b) => !b.plantillasTransaccionales || !b.plantillasMarketing || !b.plantillasTransaccionales.some((t) => b.plantillasMarketing!.includes(t)),
      { message: "Una plantilla no puede estar en plantillasTransaccionales y plantillasMarketing a la vez." },
    );

  app.patch("/hoteles/:hotelId/mensajeria/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));
    const current = await ensureMessagingConfig(db, hotelId, c.get("orgId"));

    const transactionalTemplates = body.plantillasTransaccionales ?? current.transactionalTemplates;
    const marketingTemplates = body.plantillasMarketing ?? current.marketingTemplates;
    const marketingTemplateBodies: Record<string, string> = {
      ...current.marketingTemplateBodies,
      ...(body.textosPlantillasMarketing ?? {}),
    };

    // REQ-SEG-007 -- "linter de plantillas": corre ANTES de guardar nada. Ninguna
    // plantilla puede quedar clasificada como marketing (ni la que ya estaba, ni una
    // nueva de este PATCH) sin un texto registrado que incluya una opción de baja
    // explícita y reconocible. Rechaza la petición COMPLETA (nunca guarda "a medias") si
    // cualquiera falla -- así un hotel jamás puede tener una plantilla de marketing
    // "clasificada" pero sin opción de baja verificada, ni por un instante.
    for (const templateName of marketingTemplates) {
      const lint = lintMarketingTemplateBody(marketingTemplateBodies[templateName]);
      if (!lint.ok) {
        throw Errors.validation(
          `La plantilla de marketing "${templateName}" fue rechazada por el linter de plantillas (REQ-SEG-007): ${lint.reason}`,
        );
      }
    }

    await db.query(
      `update public.hotel_messaging_config
       set transactional_templates = $1, marketing_templates = $2, marketing_template_bodies = $3, updated_at = now()
       where hotel_id = $4;`,
      [transactionalTemplates, marketingTemplates, JSON.stringify(marketingTemplateBodies), hotelId],
    );
    return c.json({
      plantillasTransaccionales: transactionalTemplates,
      plantillasMarketing: marketingTemplates,
      textosPlantillasMarketing: marketingTemplateBodies,
    });
  });

  app.post("/hoteles/:hotelId/mensajeria/mensajes", async (c) => {
    assertRole(c, [...ADMIN_ROLES, "frontdesk", "reservations"]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(enviarSchema, await c.req.json().catch(() => ({})));
    await ensureMessagingConfig(db, hotelId, orgId);

    // REQ-HUE-021/REQ-SEG-007: se rechaza ANTES de crear una solicitud de aprobación --
    // sin este chequeo temprano, una plantilla de marketing sin opt-in quedaría
    // "pendiente_aprobacion" y un gerente podría aprobarla sin saber que el envío real
    // fallará de todos modos (`tool.run()` la bloquea igual, ver
    // `isMarketingSendBlocked`, defensa en profundidad para cualquier otra vía de
    // ejecución: AgentRunner, aprobación diferida). Aquí se devuelve el rechazo
    // inmediato y claro en vez de una promesa de aprobación que nunca podría cumplirse.
    if (await isMarketingSendBlocked({ db, hotelId, templateName: body.templateName, guestPhone: body.guestPhone })) {
      throw Errors.conflict(
        `No existe opt-in de marketing registrado para ${body.guestPhone}; la plantilla "${body.templateName}" está clasificada como marketing y no puede enviarse sin ese opt-in previo.`,
      );
    }

    const tool = createSendWhatsappTemplateTool({ db, messaging: sharedWhatsappAdapter, simulated: true });
    const approvalQueue = createTransactionalTemplateApprovalQueue(
      new PostgresApprovalQueue(db),
      transactionalTemplateCheckFromDb(db),
    );

    const input: SendWhatsappTemplateInput = {
      guestPhone: body.guestPhone,
      templateName: body.templateName,
      languageCode: body.languageCode,
      parameters: body.parameters,
    };
    const inputSummary = `Plantilla "${body.templateName}" a ${body.guestPhone}: ${body.parameters.join(" | ") || "(sin parámetros)"}`;
    const approval = await approvalQueue.request({
      toolName: SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
      input,
      orgId,
      hotelId,
      requestedBy: `staff:${c.get("userId")}:whatsapp-${body.guestPhone}`,
      isMoney: false,
      textoMostrado: inputSummary,
      inputSummary,
    });

    if (approval.status === "aprobada") {
      const ctx = buildToolContext(
        { orgId, hotelId, actor: { type: "staff", id: c.get("userId") }, requestId: c.get("requestId") },
        createRunBudget({}),
      );
      const result = await tool.run(ctx, input);
      return c.json({ estado: "enviado", summary: result.summary, ...(result.data as object) }, 201);
    }
    if (approval.status === "rechazada") {
      return c.json({ estado: "rechazado", aprobacionId: approval.id }, 409);
    }
    return c.json({ estado: "pendiente_aprobacion", aprobacionId: approval.id }, 202);
  });

  return app;
}
