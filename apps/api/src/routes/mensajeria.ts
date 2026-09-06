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
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
  buildToolContext,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  PostgresApprovalQueue,
  transactionalTemplateCheckFromDb,
  type SendWhatsappTemplateInput,
} from "@atiende-hoteles/agent-core";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { WebhookReplayError, WebhookSignatureError } from "@atiende-hoteles/mcp-shared";
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
}

/** Config de mensajería del hotel (secreto de webhook simulado + plantillas
 * transaccionales). Se crea perezosamente con valores por defecto seguros la primera vez
 * que el hotel usa mensajería -- ningún gerente necesita un paso de setup previo para que
 * la bandeja funcione, y puede ajustar las plantillas transaccionales después. */
async function ensureMessagingConfig(
  db: DbClient,
  hotelId: string,
  orgId: string,
): Promise<{ webhookSecret: string; transactionalTemplates: string[] }> {
  const { rows } = await db.query<{ webhook_secret: string; transactional_templates: string[] }>(
    "select webhook_secret, transactional_templates from public.hotel_messaging_config where hotel_id = $1;",
    [hotelId],
  );
  if (rows[0]) return { webhookSecret: rows[0].webhook_secret, transactionalTemplates: rows[0].transactional_templates };

  const webhookSecret = randomUUID();
  await db.query(
    `insert into public.hotel_messaging_config (hotel_id, tenant_id, webhook_secret)
     values ($1, $2, $3)
     on conflict (hotel_id) do nothing;`,
    [hotelId, orgId, webhookSecret],
  );
  const { rows: after } = await db.query<{ webhook_secret: string; transactional_templates: string[] }>(
    "select webhook_secret, transactional_templates from public.hotel_messaging_config where hotel_id = $1;",
    [hotelId],
  );
  return { webhookSecret: after[0]!.webhook_secret, transactionalTemplates: after[0]!.transactional_templates };
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
      await deps.engine.admin.query(
        `insert into public.message (tenant_id, hotel_id, conversation_id, direction, channel, body, external_message_id, delivery_status, simulated)
         values ($1, $2, $3, 'entrante', 'whatsapp', $4, $5, 'entregado', true);`,
        [configRows[0].tenant_id, hotelId, convRows[0]!.id, event.textBody ?? "(mensaje sin texto)", event.externalMessageId ?? null],
      );
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
              delivery_status::text as delivery_status, simulated, created_at::text as created_at
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
      })),
    );
  });

  app.get("/hoteles/:hotelId/mensajeria/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const config = await ensureMessagingConfig(db, c.req.param("hotelId"), c.get("orgId"));
    return c.json({ plantillasTransaccionales: config.transactionalTemplates });
  });

  app.patch("/hoteles/:hotelId/mensajeria/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(z.object({ plantillasTransaccionales: z.array(z.string().trim().min(1).max(60)).max(50) }), await c.req.json().catch(() => ({})));
    await ensureMessagingConfig(db, hotelId, c.get("orgId"));
    await db.query("update public.hotel_messaging_config set transactional_templates = $1, updated_at = now() where hotel_id = $2;", [
      body.plantillasTransaccionales,
      hotelId,
    ]);
    return c.json({ plantillasTransaccionales: body.plantillasTransaccionales });
  });

  app.post("/hoteles/:hotelId/mensajeria/mensajes", async (c) => {
    assertRole(c, [...ADMIN_ROLES, "frontdesk", "reservations"]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(enviarSchema, await c.req.json().catch(() => ({})));
    await ensureMessagingConfig(db, hotelId, orgId);

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
