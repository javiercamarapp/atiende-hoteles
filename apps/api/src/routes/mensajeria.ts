// H6b · /hoteles/:hotelId/mensajeria — bandeja de conversaciones de WhatsApp por huésped
// (REQ-HUE-001/002, REQ-HK-002/013/021, H09) sobre `MessagingPort`
// (packages/mcp-servers/whatsapp): `MetaWhatsappAdapter` real si `WHATSAPP_ACCESS_TOKEN`/
// `WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_APP_SECRET` están configuradas (ver
// `lib/messaging.ts`, mismo patrón que `resolveEmailPort`), `FakeWhatsappAdapter` si no
// (ADR-007 "PENDIENTE DE CREDENCIALES") -- fix de auditoría: antes de este cambio era
// SIEMPRE el Fake, sin rama condicional, aunque las credenciales estuvieran presentes.
// Enviar una plantilla reutiliza la MISMA tool de dominio de agent-core
// (`enviar_mensaje_whatsapp_plantilla`); las plantillas transaccionales configuradas por
// hotel (`hotel_messaging_config.transactional_templates`) se auto-aprueban sin espera
// humana (`createTransactionalTemplateApprovalQueue`), cualquier otra queda pendiente en
// `agent_approval` hasta que routes/aprobaciones.ts la decida.
//
// El webhook de entrada (`GET`/`POST /hoteles/:hotelId/mensajeria/webhook`) es PUBLICO
// (Meta no manda un Bearer de staff): el `GET` es la verificación de suscripción que
// Meta exige antes de activar cualquier webhook (`hub.challenge`, ver handler abajo); la
// autorización del `POST` es la firma HMAC-SHA256 del cuerpo crudo (`X-Hub-Signature-256`)
// -- contra el `WHATSAPP_APP_SECRET` real cuando hay credenciales de Meta, o contra el
// `webhook_secret` por hotel (desarrollo/pruebas) si no las hay, ver
// `resolveWhatsappWebhookVerifier` en `lib/messaging.ts` -- mismo criterio de "sin sesión
// de staff, cliente admin" que `routes/cancelacionPublica.ts`. Idempotencia por
// `event_id` vía `idempotency_key` (0009/0011): un replay del MISMO evento nunca
// reprocesa ni duplica un mensaje.
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
//
// REQ-SEG-001 (auditoria-2/legal [ALTO]): el disclosure de primer turno ahora compone
// además la URL real del aviso de privacidad (`AVISO_PRIVACIDAD_PATH` resuelto contra
// `deps.env.frontendUrl`, mismo criterio que routes/registro.ts/correo.ts para construir
// enlaces absolutos) -- este webhook es el ÚNICO "primer contacto" real por WhatsApp de
// todo el repo, así que es donde debía vivir el enlace, no solo el texto de GOB-034.
//
// REQ-HUE-026 (H08-024): mismo criterio que REQ-HUE-006/014 de arriba -- este webhook es
// el único punto real que procesa un mensaje entrante, así que es donde se conecta la
// consulta al panel de "conocimiento local" (`local_knowledge_entry`, migración 0052)
// cuando el texto pregunta por sargazo/clima/playa/ferry/eventos
// (`detectLocalKnowledgeCategory`/`buildLocalKnowledgeReply`, domain-hotel): la lectura
// es directa a Postgres sin caché, así que un cambio guardado por el gerente ya está
// disponible en la siguiente pregunta de un huésped.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
  AGENT_DEFINITIONS,
  AVISO_PRIVACIDAD_PATH,
  RECEPCION_VIRTUAL,
  buildDisclosureMessageConAvisoPrivacidad,
  buildToolContext,
  createGuestTicketTool,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  isMarketingSendBlocked,
  isGuestContactMaskedByOta,
  esPreguntaSiEsHumano,
  PostgresApprovalQueue,
  RESPUESTA_FIJA_ES_HUMANO,
  transactionalTemplateCheckFromDb,
  type SendWhatsappTemplateInput,
} from "@atiende-hoteles/agent-core";
import { WebhookReplayError, WebhookSignatureError } from "@atiende-hoteles/mcp-shared";
import {
  buildLocalKnowledgeReply,
  classifyGuestMessage,
  detectAndRedactPaymentData,
  detectLocalKnowledgeCategory,
  lintMarketingTemplateBody,
  looksLikeArcoRequest,
  looksLikeCancellationIntent,
  looksLikeCheckinDataInFreeText,
  looksLikePaymentComplaint,
} from "@atiende-hoteles/domain-hotel";
import { resolveWhatsappWebhookVerifier, sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import type { DbClient } from "@atiende-hoteles/db";
import { resolveAgentConfig } from "./agentes.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// REQ-HUE-014 (mensaje/petición del huésped -> `guest_ticket`, ver comentario extenso
// más abajo junto al bloque que la usa): definición de `recepcion_virtual` ya
// catalogada en agent-core `agents.ts` -- MISMO patrón `AGENT_DEFINITIONS[...]!` que
// `routes/vozElevenlabs.ts` (ese archivo importa `RECEPCION_VIRTUAL_DEF` con este
// nombre exacto; se reutiliza aquí sin re-declarar la tabla de agentes).
const RECEPCION_VIRTUAL_DEF = AGENT_DEFINITIONS[RECEPCION_VIRTUAL]!;

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

  // GET de verificación de webhook (Meta lo exige para poder activar CUALQUIER webhook,
  // https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests):
  // al configurar la URL en el panel de Meta for Developers, Meta manda esta petición
  // UNA vez con `hub.mode=subscribe`, `hub.verify_token` (el valor que tú mismo elegiste
  // al configurar el webhook) y `hub.challenge` (un valor aleatorio) -- si el token
  // coincide, se responde el `hub.challenge` tal cual (texto plano, no JSON) y Meta
  // activa el webhook; si no coincide (o no hay token configurado), se rechaza SIEMPRE
  // (fail-closed, nunca se activa un webhook con un token adivinado). El `verify_token`
  // es del ÚNICO webhook de la app de Meta (no por hotel, ver limitación documentada en
  // lib/messaging.ts) -- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` es una sola variable de entorno
  // global, no una columna de `hotel_messaging_config`.
  app.get("/hoteles/:hotelId/mensajeria/webhook", (c) => {
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (!expected || mode !== "subscribe" || !token || token !== expected || !challenge) {
      throw Errors.forbidden("Verificación de webhook de Meta fallida (hub.verify_token ausente o no coincide).");
    }
    return c.text(challenge, 200);
  });

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

    const adapter = resolveWhatsappWebhookVerifier(configRows[0].webhook_secret);
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
         values ($1, $2, $3, 'entrante', 'whatsapp', $4, $5, 'entregado', $6, $7);`,
        [
          configRows[0].tenant_id,
          hotelId,
          convRows[0]!.id,
          bodyParaGuardar,
          event.externalMessageId ?? null,
          whatsappAdapterSimulated,
          pago.containsSensitiveData,
        ],
      );

      // REQ-HUE-006: disclosure de IA en el PRIMER mensaje del hilo -- se envía antes
      // de cualquier otra respuesta automática (tarjeta/check-in de abajo) para que sea
      // lo primero que el huésped recibe de vuelta en la conversación.
      if (esPrimerTurno) {
        // REQ-SEG-001: URL absoluta real (no relativa) porque el destino es un mensaje
        // de WhatsApp, no un `<Link>` de apps/web -- mismo patrón que
        // routes/registro.ts/correo.ts (`new URL(path, deps.env.frontendUrl)`).
        const avisoPrivacidadUrl = new URL(AVISO_PRIVACIDAD_PATH, deps.env.frontendUrl).toString();
        const disclosureConAviso = buildDisclosureMessageConAvisoPrivacidad(avisoPrivacidadUrl);
        const disclosure = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "disclosure_ia",
          languageCode: "es_MX",
          // Con `MetaWhatsappAdapter` real, este parámetro SÍ viaja en el `template.
          // components[0].parameters` del POST real a Graph API (ver
          // meta-whatsapp-adapter.ts); con el Fake (sin credenciales), se ignora para el
          // envío pero el `body` guardado abajo (`disclosureConAviso`) es la fuente
          // verificable de todos modos, real o simulado.
          parameters: [avisoPrivacidadUrl],
          clientMessageId: `disclosure-ia-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'disclosure_ia', $4, $5, $6, $7);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, disclosureConAviso, disclosure.externalMessageId, disclosure.status, whatsappAdapterSimulated],
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
           values ($1, $2, $3, 'saliente', 'whatsapp', 'respuesta_es_humano', $4, $5, $6, $7);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, RESPUESTA_FIJA_ES_HUMANO, respuesta.externalMessageId, respuesta.status, whatsappAdapterSimulated],
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
                   $4, $5, $6);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, aviso.externalMessageId, aviso.status, whatsappAdapterSimulated],
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
                   $4, $5, $6);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, redirect.externalMessageId, redirect.status, whatsappAdapterSimulated],
        );
      }

      // Patrón Likida/atiende.ai #8 (fast-path determinista antes del LLM/ticket
      // genérico, intent 1/3): "cancelar mi reserva" por chat se redirige al endpoint
      // ya verificado y estructurado (`POST /reservas/cancelacion-publica`,
      // REQ-RES-005, exige código de reserva + apellido) en vez de caer en la
      // clasificación genérica de ticket -- MISMO criterio que el bloque de check-in de
      // arriba: nunca ejecuta la cancelación aquí, solo redirige.
      if (looksLikeCancellationIntent(event.textBody)) {
        const redirect = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "cancelacion_enlace_estructurado",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `cancelacion-redirect-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'cancelacion_enlace_estructurado',
                   'Para cancelar tu reserva por tu seguridad te pedimos verificar tu código de reserva y apellido: te compartimos el enlace seguro.',
                   $4, $5, $6);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, redirect.externalMessageId, redirect.status, whatsappAdapterSimulated],
        );
      }

      // Patrón Likida/atiende.ai #8 (intent 2/3): una queja de pago/disputa de cobro
      // (distinta de la captura de PAN que ya cubre `pago.containsCardNumber` arriba)
      // se redirige a la plantilla de soporte de pagos -- nunca decide ni ejecuta
      // ningún reembolso/reverso aquí (eso sigue siendo exclusivo de staff con
      // `MONEY_ROLES` vía `POST .../folios/.../reverso`).
      if (looksLikePaymentComplaint(event.textBody)) {
        const redirect = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "queja_pago_enlace_soporte",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `queja-pago-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'queja_pago_enlace_soporte',
                   'Lamentamos el inconveniente con tu cobro: te compartimos un enlace seguro para que nuestro equipo revise tu caso.',
                   $4, $5, $6);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, redirect.externalMessageId, redirect.status, whatsappAdapterSimulated],
        );
      }

      // Patrón Likida/atiende.ai #8 (intent 3/3): un derecho ARCO/privacidad pedido por
      // chat se redirige al flujo estructurado y auditado ya existente
      // (`POST /privacidad/solicitud`, REQ-SEG-002) -- nunca ejecuta ningún borrado/
      // exportación de datos aquí, solo redirige.
      if (looksLikeArcoRequest(event.textBody)) {
        const redirect = await sharedWhatsappAdapter.sendTemplateMessage({
          to: event.from,
          templateName: "arco_enlace_estructurado",
          languageCode: "es_MX",
          parameters: [],
          clientMessageId: `arco-redirect-${event.eventId}`,
        });
        await deps.engine.admin.query(
          `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, template_name, body, external_message_id, delivery_status, simulated)
           values ($1, $2, $3, 'saliente', 'whatsapp', 'arco_enlace_estructurado',
                   'Para ejercer tus derechos ARCO sobre tus datos personales, te compartimos el enlace seguro de solicitud.',
                   $4, $5, $6);`,
          [configRows[0].tenant_id, hotelId, convRows[0]!.id, redirect.externalMessageId, redirect.status, whatsappAdapterSimulated],
        );
      }

      // Gate único de `recepcion_virtual` (agent_config) para TODA acción autónoma de
      // este agente sobre WhatsApp -- conocimiento local (REQ-HUE-026, abajo) y ticket
      // (REQ-HUE-014, más abajo) comparten la MISMA resolución de gate (una sola
      // consulta, no una por acción): mismo criterio que `routes/vozElevenlabs.ts` punto
      // 3 de su comentario de archivo para el canal de voz del mismo agente. Disclosure/
      // "es humano"/tarjeta/check-in NO se gatean aquí a propósito: son respuestas de
      // cumplimiento/seguridad fijas (GOB-034/REQ-HUE-010/REQ-RES-016), no una decisión
      // del agente sobre si "ayudar" al huésped -- eso sí depende del gate.
      const agentConfig = await resolveAgentConfig(deps.engine.admin, hotelId, RECEPCION_VIRTUAL_DEF);
      const recepcionVirtualActiva = agentConfig.gate !== "shadow";

      // REQ-HUE-026 (H08-024): "el panel de conocimiento local ... editable por el
      // gerente y reflejado en las respuestas del agente conversacional en <30 s." La
      // fuente de datos real (`local_knowledge_entry`, migración 0052) y su CRUD
      // (`routes/conocimientoLocal.ts`) ya existían; el comentario de cabecera de esa
      // ruta admitía explícitamente que faltaba la CONEXIÓN -- que el agente
      // conversacional realmente la consultara al responder. Este es ese punto de
      // conexión: el mismo webhook (único punto real de entrada de un mensaje de
      // huésped, ver comentario de archivo) detecta si el texto pregunta por sargazo/
      // clima/playa/ferry/eventos (`detectLocalKnowledgeCategory`, domain-hotel) y, si
      // hay una entrada vigente para esa categoría en ESTE hotel, responde con su
      // contenido ACTUAL -- lectura directa a Postgres sin caché intermedio (misma
      // fuente y mismo criterio de latencia que `tests/integration/conocimiento-local/
      // latencia.spec.ts`), así que un cambio que el gerente guarda un segundo antes de
      // que el huésped pregunte YA está reflejado en la respuesta.
      //
      // `sendTextMessage` (no `sendTemplateMessage`): esta es una respuesta DENTRO de la
      // ventana de servicio de 24h que el propio mensaje entrante acaba de abrir (mismo
      // criterio documentado en `MessagingPort.sendTextMessage`, packages/mcp-servers/
      // whatsapp/src/port.ts) -- no requiere plantilla pre-aprobada por Meta.
      //
      // Sin ninguna entrada para esa categoría en este hotel: no se envía nada aquí
      // (`buildLocalKnowledgeReply` devuelve `null`, nunca inventa contenido que el
      // gerente no escribió, mismo criterio de "estado vacío honesto" de REQ-UX-002) y
      // el mensaje sigue su curso normal hacia el ticket de abajo -- una pregunta sin
      // respuesta configurada termina en frontdesk, no en silencio.
      let categoriaConocimientoLocalRespondida = false;
      const categoriaConocimientoLocal = recepcionVirtualActiva ? detectLocalKnowledgeCategory(event.textBody) : null;
      if (categoriaConocimientoLocal) {
        const { rows: entradasConocimiento } = await deps.engine.admin.query<{
          title: string;
          content: string;
          updated_at: string;
        }>(
          `select title, content, updated_at::text as updated_at
           from public.local_knowledge_entry where hotel_id = $1 and category = $2;`,
          [hotelId, categoriaConocimientoLocal],
        );
        const respuestaConocimientoLocal = buildLocalKnowledgeReply(
          categoriaConocimientoLocal,
          entradasConocimiento.map((fila) => ({ title: fila.title, content: fila.content, updatedAt: fila.updated_at })),
        );
        if (respuestaConocimientoLocal) {
          const envioConocimiento = await sharedWhatsappAdapter.sendTextMessage({
            to: event.from,
            body: respuestaConocimientoLocal,
            clientMessageId: `conocimiento-local-${event.eventId}`,
          });
          await deps.engine.admin.query(
            `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, body, external_message_id, delivery_status, simulated)
             values ($1, $2, $3, 'saliente', 'whatsapp', $4, $5, $6, $7);`,
            [
              configRows[0].tenant_id,
              hotelId,
              convRows[0]!.id,
              respuestaConocimientoLocal,
              envioConocimiento.externalMessageId,
              envioConocimiento.status,
              whatsappAdapterSimulated,
            ],
          );
          categoriaConocimientoLocalRespondida = true;
        }
      }

      // REQ-HUE-014: "cada mensaje/petición del huésped debe convertirse en un ticket
      // con departamento/habitación/prioridad/SLA" -- este webhook es el ÚNICO punto
      // real de este repo que procesa un mensaje entrante de WhatsApp (ver comentario de
      // archivo), así que es donde debía conectarse: hasta este cambio, un texto libre
      // que no calzaba ninguno de los patrones fijos de arriba (disclosure/es-humano/
      // tarjeta/check-in) solo se guardaba (INSERT de arriba) sin ninguna acción de
      // negocio -- `classifyGuestMessage`/`createGuestTicketTool` (domain-hotel/
      // agent-core) ya existían y los usaban `routes/tickets.ts` (QR/staff sin selector
      // de categoría) y `routes/agentes.ts` (escalación de menor no acompañado); esta es
      // la MISMA función y la MISMA tool, no una reimplementación -- "una sola
      // implementación de la regla, todos los caminos de entrada" (mismo criterio que el
      // comentario de cabecera de `ticketTools.ts`).
      //
      // Se omite cuando el mensaje ya disparó una de las respuestas fijas de arriba
      // (pregunta "¿eres humano?", número de tarjeta, intento de check-in por texto) o
      // una respuesta REAL de conocimiento local (REQ-HUE-026, arriba): esos ya tienen
      // su propia respuesta resuelta, no son peticiones operativas que un departamento
      // deba atender. Una pregunta de conocimiento local SIN entrada configurada
      // (`categoriaConocimientoLocalRespondida === false` pese a haber detectado
      // categoría) NO se excluye a propósito: cae al ticket de abajo para que frontdesk
      // la atienda, en vez de quedar sin ninguna respuesta. El disclosure de primer
      // turno NO es una exclusión -- es incondicional por turno, no una clasificación de
      // contenido, así que el mismo mensaje que dispara el disclosure también puede
      // generar su ticket.
      //
      // Gate del hotel para `recepcion_virtual` (`recepcionVirtualActiva`, resuelto una
      // sola vez arriba junto con el gate de conocimiento local) -- MISMO criterio que
      // `routes/vozElevenlabs.ts` punto 3 de su comentario de archivo: mientras el gate
      // siga en "shadow" (default, BP-016), no se crea ningún ticket real desde este
      // canal -- el WhatsApp entrante es otro transporte del MISMO agente
      // `recepcion_virtual` que ya respeta ese gate en voz. "propone"/"autopilot" sí
      // crean el ticket: `crear_ticket_huesped` tiene `needsApproval: false` (ver
      // comentario de `ticketTools.ts`: registrar una petición no mueve dinero ni sale
      // del sistema, GOB-026 no aplica), así que no hay una cola de aprobación
      // intermedia que distinga esos dos gates para esta tool en particular (igual que
      // en `AgentRunner.run()`, runner.ts).
      //
      // Sin habitación: ninguna tabla de este repo asocia un teléfono de WhatsApp
      // (`guest.phone`) a una reserva/habitación activa (ver 0005_guest.sql/
      // 0006_reservation.sql -- `reservation` ni siquiera referencia `room`, solo
      // `room_type`; el canal "qr" resuelve la habitación porque el QR de la propia
      // habitación se la manda explícita al crear el ticket, `routes/tickets.ts`). Se
      // crea el ticket SIN `roomCode` (la tool ya soporta esto, ver `ticketTools.ts`)
      // en vez de adivinar una habitación -- honestidad de "esqueleto real" (ADR-006/
      // 007) sobre inventar una asociación que este repo no puede verificar hoy.
      // Patrón Likida/atiende.ai #8: los 3 fast-paths deterministas de arriba
      // (cancelación/queja de pago/ARCO) ya tienen su propia respuesta fija resuelta --
      // igual que check-in/tarjeta/"¿eres humano?", no son peticiones operativas que un
      // departamento deba atender vía ticket genérico.
      const mensajeYaAtendidoPorPatronFijo =
        esPreguntaSiEsHumano(event.textBody) ||
        pago.containsCardNumber ||
        looksLikeCheckinDataInFreeText(event.textBody) ||
        looksLikeCancellationIntent(event.textBody) ||
        looksLikePaymentComplaint(event.textBody) ||
        looksLikeArcoRequest(event.textBody) ||
        categoriaConocimientoLocalRespondida;
      if (event.textBody && event.textBody.trim().length > 0 && !mensajeYaAtendidoPorPatronFijo) {
        if (recepcionVirtualActiva) {
          const classification = classifyGuestMessage(bodyParaGuardar);
          const ticketCtx = buildToolContext(
            {
              orgId: configRows[0].tenant_id,
              hotelId,
              actor: { type: "system", id: "whatsapp_webhook" },
              requestId: `whatsapp-ticket-${event.eventId}`,
            },
            createRunBudget({}),
          );
          await createGuestTicketTool({ db: deps.engine.admin }).run(ticketCtx, {
            guestMessage: bodyParaGuardar,
            department: classification.department,
            priority: classification.priority,
            channel: "whatsapp",
          });
        }
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

    // REQ-RES-018: mismo criterio de rechazo temprano que el gate de marketing de abajo
    // -- un envío a un contacto que sigue siendo el relay enmascarado de una OTA nunca
    // debe quedar "pendiente_aprobacion" (`tool.run()` lo bloquea igual, defensa en
    // profundidad para AgentRunner/aprobación diferida, ver `isGuestContactMaskedByOta`).
    if (await isGuestContactMaskedByOta({ db, hotelId, guestPhone: body.guestPhone })) {
      throw Errors.conflict(
        `${body.guestPhone} pertenece a una reserva cuyo contacto sigue siendo el relay enmascarado de una OTA -- envía el enlace de check-in por el canal de la OTA (POST .../checkin-link-ota) en vez de WhatsApp hasta que el huésped comparta su contacto real.`,
      );
    }

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

    const tool = createSendWhatsappTemplateTool({ db, messaging: sharedWhatsappAdapter, simulated: whatsappAdapterSimulated });
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
