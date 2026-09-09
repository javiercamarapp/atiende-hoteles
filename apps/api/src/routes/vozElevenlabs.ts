// fix/voz-elevenlabs · Telefonia/voz real del agente `recepcion_virtual` con ElevenLabs
// Conversational AI -- MISMO PATRON del repo hermano atiende-restaurantes (ver
// docs/agente-voz/ de ESTE repo para el diseño completo, y
// ~/Desktop/supabase/restaurantes/supabase/functions/{agent-config,create-order,
// cotizar-pedido,customer-lookup} para el original que se adaptó): ElevenLabs es quien
// maneja telefonía + modelo de voz de punta a punta vía su propia plataforma de agentes
// conversacionales, no Twilio+STT/TTS por separado. Ese repo hermano usa Supabase Edge
// Functions (una función HTTP por tool); este usa Hono/Node (apps/api) -- el ajuste de
// stack es solo el transporte, la lógica de autenticación/gate/aprobación es la MISMA.
//
// HONESTIDAD (ADR-006/007, "esqueleto honesto" -- ver docs/agente-voz/README.md §0):
// este archivo implementa la llamada HTTP REAL que ElevenLabs hace a nuestro backend
// (nosotros somos el RECEPTOR, no el llamador -- por eso SÍ se puede probar de verdad
// sin credenciales de ElevenLabs, a diferencia de un proxy que llamara a la API de
// ElevenLabs). No existe cuenta real de ElevenLabs conectada en este entorno: el
// simulador de tests/integration/api/voz-elevenlabs.spec.ts y
// scripts/voz-elevenlabs-webhook-simulator.ts imitan el contrato documentado
// (docs/agente-voz/webhook-contrato.md), pero NADA aquí se ha ejercitado contra una
// llamada telefónica real todavía -- ver docs/agente-voz/runbook-pasos-manuales.md para
// los pasos manuales pendientes (crear el agente, pegar el prompt, configurar cada tool,
// comprar/portar el número).
//
// SEGURIDAD/GOBIERNO (decisión de diseño explícita de esta tarea, distinta de
// atiende-restaurantes):
//   1. Secreto POR HOTEL (`hotel_voice_agent_config.tool_webhook_secret`), no un secreto
//      global compartido -- el aislamiento por tenant es el eje de seguridad central de
//      ESTE repo (REQ-TEN-*), a diferencia de atiende-restaurantes (un secreto único
//      `VOICE_TOOL_SECRET` para todas las sucursales). Un hotel nunca puede, ni por bug
//      de configuración, invocar las tools de otro hotel.
//   2. El catálogo de tools expuesto es EXACTAMENTE el de `recepcion_virtual`
//      (agent-core `agents.ts`) -- las 4 tools ya existentes (housekeeping, mantenimiento,
//      WhatsApp, ROI), sin agregar ninguna tool de disponibilidad/reserva/cotización/cobro
//      (límite de seguridad ya documentado en ese catálogo). No se agregó ninguna tool
//      nueva de solo-lectura en esta tarea: la única candidata razonable (consultar el
//      estado de una reserva/ticket propio) requeriría verificar de forma confiable que
//      quien llama es ESE huésped -- este canal todavía no resuelve esa identidad
//      (ninguna variable de sistema de ElevenLabs para el número de quien llama se
//      pudo verificar contra una cuenta real en este entorno, ver
//      docs/agente-voz/README.md §5) -- construirla ahora sería exactamente el tipo de
//      "probablemente funciona" que ADR-006/007 prohíben.
//   3. El gate del hotel para `recepcion_virtual` (`agent_config`, agentes.ts
//      `resolveAgentConfig`) SIGUE APLICANDO aquí, igual que dentro de `AgentRunner`
//      (runner.ts): mientras el gate sea "shadow" (default, BP-016), ninguna tool con
//      effect != "read" se ejecuta de verdad -- ElevenLabs recibe una respuesta honesta
//      de "no ejecutado (shadow)", nunca un efecto real silencioso. Sin esto, este
//      webhook sería una puerta trasera que le da al canal de voz autopilot real
//      aunque el hotel nunca lo haya activado para ningún otro canal.
//   4. `enviar_mensaje_whatsapp_plantilla` (effect="external") sigue exigiendo
//      aprobación humana (GOB-026) -- y SIEMPRE cae en aprobación humana explícita para
//      este canal (nunca auto-aprobación de "plantilla transaccional"): ese
//      auto-aprobado (`transactionalTemplateCheckFromDb`, agent-core messagingTools.ts)
//      exige que el destinatario sea el huésped YA VERIFICADO de la conversación
//      (`requestedBy` con forma `agent:<agente>:guest:<telefono>`) -- este webhook NO
//      tiene ese teléfono verificado (punto 2), así que `requestedBy` se codifica con
//      actor "voz" (nunca "guest"), lo que hace que ese chequeo falle de forma
//      determinista y la solicitud quede pendiente de un humano, por diseño.
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  AGENT_DEFINITIONS,
  buildToolContext,
  createHousekeepingTaskTool,
  createMaintenanceTicketTool,
  createRegistrarEventoRoiTool,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  PostgresApprovalQueue,
  RECEPCION_VIRTUAL,
  transactionalTemplateCheckFromDb,
  type ToolDefinition,
} from "@atiende-hoteles/agent-core";
import type { DbClient } from "@atiende-hoteles/db";
import { sharedWhatsappAdapter } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import { resolveAgentConfig } from "./agentes.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const RECEPCION_VIRTUAL_DEF = AGENT_DEFINITIONS[RECEPCION_VIRTUAL]!;

interface VoiceAgentConfigRow {
  elevenlabs_agent_id: string | null;
  tool_webhook_secret: string;
  tenant_id: string;
  enabled: boolean;
}

const VOICE_CONFIG_SELECT =
  "select elevenlabs_agent_id, tool_webhook_secret, tenant_id, enabled from public.hotel_voice_agent_config where hotel_id = $1;";

/** Crea perezosamente la fila de config (secreto nuevo, `enabled=false`) la primera vez
 *  que un owner/gm abre la pantalla de configuración del agente de voz de su hotel --
 *  mismo criterio que `ensureMessagingConfig` (routes/mensajeria.ts). Nunca se genera un
 *  secreto real "on the fly" para una llamada del webhook público: si no existe fila,
 *  el webhook responde 404 (no confundir con `mensajeria.ts`, donde el hotel ya trae la
 *  fila creada por esta misma pantalla ANTES de que exista tráfico real). */
async function ensureVoiceAgentConfig(db: DbClient, hotelId: string, orgId: string): Promise<VoiceAgentConfigRow> {
  const { rows } = await db.query<VoiceAgentConfigRow>(VOICE_CONFIG_SELECT, [hotelId]);
  if (rows[0]) return rows[0];
  const secret = randomUUID();
  await db.query(
    `insert into public.hotel_voice_agent_config (hotel_id, tenant_id, tool_webhook_secret)
     values ($1, $2, $3)
     on conflict (hotel_id) do nothing;`,
    [hotelId, orgId, secret],
  );
  const { rows: after } = await db.query<VoiceAgentConfigRow>(VOICE_CONFIG_SELECT, [hotelId]);
  return after[0]!;
}

/** Comparación en tiempo constante que además evita filtrar la LONGITUD del secreto
 *  real (comparar los digests SHA-256 de ambos valores en vez de los valores crudos --
 *  `timingSafeEqual` exige buffers del mismo tamaño, y dos secretos de longitud
 *  distinta ya sería una fuga de por sí si se comparara `Buffer.from(a)` vs
 *  `Buffer.from(b)` directo). */
function secretMatches(received: string | null | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** ElevenLabs documenta el webhook de una tool con DOS formas posibles según la versión/
 *  configuración exacta del tool (ver docs/agente-voz/webhook-contrato.md §2 para el
 *  detalle honesto de por qué esto no se pudo verificar contra una cuenta real):
 *    (a) el cuerpo ES literalmente el `request_body_schema` declarado (patrón que usa
 *        de verdad atiende-restaurantes, confirmado contra un agente real funcionando);
 *    (b) `{ tool_call_id, tool_name, parameters, conversation_id }` (formato genérico
 *        documentado por la skill empaquetada "agents" de este entorno).
 *  Se acepta CUALQUIERA de las dos formas en vez de apostar a una sola -- si llega un
 *  objeto `parameters`, se usa ese; si no, se usa el cuerpo completo. */
function extractToolParams(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Solo se desenvuelve `parameters` cuando el cuerpo en verdad TRAE la forma del
    // sobre genérico de ElevenLabs (`tool_call_id`/`tool_name` junto a `parameters`) --
    // nunca por la sola presencia de un campo llamado "parameters", porque el propio
    // esquema de `enviar_mensaje_whatsapp_plantilla` YA tiene un campo real llamado
    // `parameters` (un arreglo, no un objeto) para los valores de la plantilla de
    // WhatsApp. Confundir ambos hacía que un envío real de plantilla con parámetros se
    // rechazara siempre como "entrada inválida" (bug real encontrado al escribir el
    // test de integración de este mismo archivo).
    const looksLikeElevenLabsEnvelope =
      obj.parameters !== null &&
      typeof obj.parameters === "object" &&
      !Array.isArray(obj.parameters) &&
      (typeof obj.tool_name === "string" || typeof obj.tool_call_id === "string");
    if (looksLikeElevenLabsEnvelope) {
      return obj.parameters as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

function toolCallId(raw: unknown, params: Record<string, unknown>): string {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const candidate = obj.tool_call_id ?? obj.conversation_id ?? params.conversation_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : randomUUID();
}

/** Envoltura `{ result }` (formato documentado por la skill "agents" para la respuesta
 *  de un webhook tool) -- ver comentario de archivo, punto de honestidad: el envoltorio
 *  exacto que ElevenLabs espera de verdad no se pudo verificar contra una cuenta real,
 *  así que se usa el documentado en vez de inventar uno. */
function toolResult(body: Record<string, unknown>) {
  return { result: body };
}

type VozToolName =
  | "crear-tarea-housekeeping"
  | "crear-ticket-mantenimiento"
  | "enviar-whatsapp-plantilla"
  | "registrar-evento-roi";

const VOZ_TOOL_NAMES = new Set<VozToolName>([
  "crear-tarea-housekeeping",
  "crear-ticket-mantenimiento",
  "enviar-whatsapp-plantilla",
  "registrar-evento-roi",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- catálogo heterogéneo: cada tool trae su propio TInput, igual que buildToolForName() en routes/agentes.ts.
function buildTool(toolName: VozToolName, db: DbClient): ToolDefinition<any> {
  switch (toolName) {
    case "crear-tarea-housekeeping":
      return createHousekeepingTaskTool({ db });
    case "crear-ticket-mantenimiento":
      return createMaintenanceTicketTool({ db });
    case "enviar-whatsapp-plantilla":
      return createSendWhatsappTemplateTool({ db, messaging: sharedWhatsappAdapter, simulated: true });
    case "registrar-evento-roi":
      return createRegistrarEventoRoiTool({ db, agentName: RECEPCION_VIRTUAL });
  }
}

export function vozElevenlabsRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // Webhook PÚBLICO: ElevenLabs no manda ningún Bearer de staff (mismo criterio que
  // `routes/mensajeria.ts`/`routes/aprobacionesWhatsapp.ts`) -- se registra ANTES del
  // bloque `app.use` de sesión de staff de abajo para que nunca quede atrapado por él.
  // `:toolName` es uno de VOZ_TOOL_NAMES; cualquier otro valor es 404 (catálogo cerrado,
  // REQ-AGT-018).
  app.post("/hoteles/:hotelId/voz/webhook/:toolName", async (c) => {
    const hotelId = c.req.param("hotelId");
    const toolNameParam = c.req.param("toolName");
    const secretHeader = c.req.header("x-atiende-voz-tool-secret");

    if (!VOZ_TOOL_NAMES.has(toolNameParam as VozToolName)) {
      throw Errors.notFound(`Tool de voz desconocida: "${toolNameParam}".`);
    }
    const toolName = toolNameParam as VozToolName;

    const { rows: configRows } = await deps.engine.admin.query<VoiceAgentConfigRow>(VOICE_CONFIG_SELECT, [hotelId]);
    const config = configRows[0];
    if (!config) throw Errors.notFound("Este hotel no tiene el agente de voz configurado.");
    if (!secretMatches(secretHeader, config.tool_webhook_secret)) {
      throw Errors.unauthorized("Secreto de webhook de voz inválido o ausente.");
    }
    if (!config.enabled) {
      throw Errors.forbidden("El agente de voz de este hotel todavía no está activado (hotel_voice_agent_config.enabled=false).");
    }

    const raw = await c.req.json().catch(() => ({}));
    const params = extractToolParams(raw);
    const requestId = toolCallId(raw, params);

    const tool = buildTool(toolName, deps.engine.admin);
    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return c.json(
        { error: `entrada inválida para "${tool.name}": ${first?.path?.join(".") || "(input)"} — ${first?.message ?? "valor inválido"}` },
        400,
      );
    }

    // Punto 3 del comentario de archivo: el gate del hotel para recepcion_virtual sigue
    // aplicando, EXACTAMENTE como runner.ts lo hace dentro de AgentRunner -- este
    // webhook nunca es una vía más permisiva que el canal de texto/WhatsApp del mismo
    // agente.
    const agentConfig = await resolveAgentConfig(deps.engine.admin, hotelId, RECEPCION_VIRTUAL_DEF);
    if (tool.effect !== "read" && agentConfig.gate === "shadow") {
      return c.json(
        toolResult({
          ok: true,
          ejecutado: false,
          modo: "shadow",
          mensaje:
            `Este hotel todavía tiene "${RECEPCION_VIRTUAL_DEF.label}" en modo shadow: la acción quedó registrada ` +
            "en la traza pero NO se ejecutó de verdad. Informa al huésped que un miembro del staff dará seguimiento.",
        }),
      );
    }

    const ctx = buildToolContext(
      { orgId: config.tenant_id, hotelId, actor: { type: "system", id: "elevenlabs_voz" }, requestId },
      createRunBudget({}),
    );

    if (tool.needsApproval) {
      // Punto 4 del comentario de archivo: `requestedBy` NUNCA lleva "guest:" aquí --
      // este canal no tiene un teléfono de huésped verificado, así que
      // `transactionalTemplateCheckFromDb` siempre rechaza el auto-aprobado y la
      // solicitud queda pendiente de un humano, sin excepción.
      const approvalQueue = createTransactionalTemplateApprovalQueue(
        new PostgresApprovalQueue(deps.engine.admin),
        transactionalTemplateCheckFromDb(deps.engine.admin),
      );
      const inputSummary = `${RECEPCION_VIRTUAL_DEF.label} (voz) solicita ejecutar "${tool.name}" en hotel ${hotelId}.`;
      const approval = await approvalQueue.request({
        toolName: tool.name,
        input: parsed.data,
        orgId: config.tenant_id,
        hotelId,
        requestedBy: `agent:${RECEPCION_VIRTUAL}:voz:${hotelId}`,
        isMoney: tool.effect === "money",
        textoMostrado: inputSummary,
        inputSummary,
      });
      if (approval.status === "rechazada") {
        return c.json(
          toolResult({
            ok: false,
            ejecutado: false,
            estado: "rechazada",
            mensaje: "Un miembro del staff ya rechazó una solicitud igual a esta; no se ejecuta.",
          }),
        );
      }
      if (approval.status !== "aprobada") {
        return c.json(
          toolResult({
            ok: true,
            ejecutado: false,
            estado: "pendiente_aprobacion",
            aprobacionId: approval.id,
            mensaje:
              "Se envió a un miembro del staff para aprobación humana antes de mandarlo. Dile al huésped que el " +
              "equipo lo confirmará en breve, no que ya quedó enviado.",
          }),
        );
      }
    }

    const result = await tool.run(ctx, parsed.data);
    return c.json(
      toolResult({
        ok: result.ok,
        ejecutado: result.ok,
        mensaje: result.summary,
        datos: result.data ?? null,
      }),
    );
  });

  // Configuración del agente de voz (owner/gm/frontdesk lectura, owner/gm escritura) --
  // sesión de staff normal, mismo criterio que `routes/mensajeria.ts` config.
  const staffOnly = "/hoteles/:hotelId/voz/config*";
  app.use(staffOnly, authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));

  app.get("/hoteles/:hotelId/voz/config", async (c) => {
    // Mismo criterio que `GET /hoteles/:hotelId/mensajeria/config`
    // (routes/mensajeria.ts): solo ADMIN_ROLES, nunca frontdesk -- a diferencia de la
    // bandeja de mensajería, el secreto de este webhook es lo único que autentica una
    // acción real ante el backend (quien lo lee puede impersonar al agente de voz), así
    // que se restringe más que el SELECT amplio de la RLS (defensa en profundidad, no
    // contradicción: la política de RLS sigue permitiendo frontdesk para un futuro
    // camino de lectura directa que hoy no existe).
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const config = await ensureVoiceAgentConfig(db, hotelId, c.get("orgId"));
    const agentConfig = await resolveAgentConfig(db, hotelId, RECEPCION_VIRTUAL_DEF);
    return c.json({
      elevenlabsAgentId: config.elevenlabs_agent_id,
      toolWebhookSecret: config.tool_webhook_secret,
      habilitado: config.enabled,
      gateRecepcionVirtual: agentConfig.gate,
      urlsWebhook: Object.fromEntries(
        [...VOZ_TOOL_NAMES].map((name) => [name, `/hoteles/${hotelId}/voz/webhook/${name}`]),
      ),
    });
  });

  const configSchema = z
    .object({
      elevenlabsAgentId: z.string().trim().min(1).max(200).nullable().optional(),
      habilitado: z.boolean().optional(),
    })
    .strict();

  app.patch("/hoteles/:hotelId/voz/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const current = await ensureVoiceAgentConfig(db, hotelId, orgId);
    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));

    const elevenlabsAgentId = body.elevenlabsAgentId !== undefined ? body.elevenlabsAgentId : current.elevenlabs_agent_id;
    const enabled = body.habilitado ?? current.enabled;

    await db.query(
      `update public.hotel_voice_agent_config
       set elevenlabs_agent_id = $1, enabled = $2, updated_at = now()
       where hotel_id = $3;`,
      [elevenlabsAgentId, enabled, hotelId],
    );
    return c.json({ elevenlabsAgentId, habilitado: enabled });
  });

  // Rotar el secreto (ej. sospecha de fuga) sin tener que borrar/recrear la fila --
  // igual que rotar cualquier otro secreto de webhook de este repo.
  app.post("/hoteles/:hotelId/voz/config/rotar-secreto", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    await ensureVoiceAgentConfig(db, hotelId, orgId);
    const nuevoSecreto = randomUUID();
    await db.query(
      "update public.hotel_voice_agent_config set tool_webhook_secret = $1, updated_at = now() where hotel_id = $2;",
      [nuevoSecreto, hotelId],
    );
    return c.json({ toolWebhookSecret: nuevoSecreto });
  });

  return app;
}
