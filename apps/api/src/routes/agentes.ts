// H7 · Runtime de agentes por rol conectado al API (ADR-006): `POST
// /hoteles/:hotelId/agentes/:agente/ejecutar` construye el `ToolContext` EXCLUSIVAMENTE
// desde la sesión ya autenticada (nunca de campos que el cliente pueda mandar en el
// cuerpo -- `hotelId` sale del parámetro de ruta ya verificado por
// `requireHotelMembership`, `gate` sale de `agent_config`/default de código, jamás del
// body), aplica el gate shadow/propone/autopilot vigente para (hotel, agente) y corta
// por presupuesto ANTES de invocar al proveedor con una respuesta honesta
// `presupuesto_agotado` -- nunca se llama al proveedor "gratis" cuando ya no queda
// presupuesto del mes.
//
// Cada paso del `AgentRunner` (AgentTraceEvent) se escribe en `audit_log` vía
// `record_audit_log()` (0008/0016, ya redactado por agent-core `redact()`), y el
// resumen agregado de la corrida se inserta en `agent_run` (0024) -- ambas escrituras
// ocurren dentro de la MISMA transacción por-request que abre `dbSession`
// (apps/api/src/middleware.ts), así que "agent_run + audit_log encadenado" o "nada de
// eso" es atómico frente a cualquier error a mitad de camino.
//
// Sin credenciales reales de proveedor LLM en este entorno: `EnvProvider` (agent-core)
// se declara `no_configurado` de forma honesta. El único camino que SÍ produce una
// respuesta completa es `demo: true` en el cuerpo, que corre un guion determinista de
// `FakeProvider` (recorrido de check-in con incidencia) y se etiqueta `simulado: true`
// en la respuesta -- nunca se hace pasar una corrida simulada por una real. Una demo
// SIEMPRE corre en gate "shadow" (forzado, sin importar el gate real configurado para
// el hotel/agente) y con un código de habitación SINTÉTICO ("DEMO-101", nunca una
// habitación real del hotel) -- así ninguna tool write/external/money del guion de
// demo ejecuta un efecto real (aud-2 agentico CRÍTICO: antes usaba el gate real y el
// primer cuarto real del hotel, así que una demo en un hotel ya en "propone"/
// "autopilot" podía marcar una habitación vendible real como fuera de servicio).
import { Hono } from "hono";
import { z } from "zod";
import {
  AgentRunner,
  DEFAULT_BATCH_PRICING,
  DEFAULT_PRICING,
  EnvProvider,
  FakeProvider,
  PostgresApprovalQueue,
  roleParamsForChannel,
  ToolRegistry,
  buildToolContext,
  createHousekeepingTaskTool,
  createMaintenanceTicketTool,
  createRegistrarEventoRoiTool,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  getAgentDefinition,
  listAgentDefinitions,
  resolveModelForRole,
  transactionalTemplateCheckFromDb,
  type AgentDefinition,
  type AgentGate,
  type AgentTraceEvent,
  type FakeStep,
  type LlmProvider,
  type ToolDefinition,
} from "@atiende-hoteles/agent-core";
import type { DbClient } from "@atiende-hoteles/db";
import { sharedWhatsappAdapter } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { HotelRole } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// .strict(): un intento de mandar "hotelId"/"gate"/"orgId" en el cuerpo se RECHAZA por
// campo desconocido en vez de ignorarse en silencio -- defensa explícita además de que
// ninguno de esos campos se lee jamás del body más abajo.
const ejecutarSchema = z
  .object({
    mensaje: z.string().trim().min(1).max(2000),
    canal: z.enum(["voz", "texto"]).default("texto"),
    // Demo determinista con FakeProvider (sin red, sin LLM real) -- ver comentario de
    // archivo. aud-2 agentico CRÍTICO: SÍ fuerza un gate distinto ("shadow", sin
    // importar el gate real configurado) -- es la única garantía de que una demo
    // nunca ejecuta un efecto real sobre datos operativos del hotel.
    demo: z.boolean().default(false),
  })
  .strict();

const configSchema = z
  .object({
    gate: z.enum(["shadow", "propone", "autopilot"]).optional(),
    techoMensualUsd: z.number().nonnegative().max(100_000).optional(),
  })
  .strict();

interface AgentConfigRow {
  gate: AgentGate;
  monthly_ceiling_usd: string;
  currency: string;
  alert_threshold_pct: string;
}

export interface ResolvedAgentConfig {
  gate: AgentGate;
  monthlyCeilingUsd: number;
  currency: string;
  alertThresholdPct: number;
}

export async function resolveAgentConfig(db: DbClient, hotelId: string, def: AgentDefinition): Promise<ResolvedAgentConfig> {
  const { rows } = await db.query<AgentConfigRow>(
    "select gate, monthly_ceiling_usd, currency, alert_threshold_pct from public.agent_config where hotel_id = $1 and agent_name = $2;",
    [hotelId, def.name],
  );
  const row = rows[0];
  return {
    gate: row?.gate ?? def.defaultGate,
    monthlyCeilingUsd: row ? Number(row.monthly_ceiling_usd) : def.defaultMonthlyCeilingUsd,
    currency: row?.currency ?? "USD",
    alertThresholdPct: row ? Number(row.alert_threshold_pct) : 0.8,
  };
}

export async function costoDelMes(db: DbClient, hotelId: string, agentName: string): Promise<number> {
  const { rows } = await db.query<{ agent_cost_mes: string }>("select public.agent_cost_mes($1, $2) as agent_cost_mes;", [
    hotelId,
    agentName,
  ]);
  return Number(rows[0]?.agent_cost_mes ?? 0);
}

/** "Sin datos" honesto (REQ-UX-002): CUENTA de corridas del mes, no si el costo dio
 *  0 -- un agente que ya corrió (aunque su costo real haya sido USD 0, p.ej. bloqueado
 *  por presupuesto agotado) SÍ tiene datos que mostrar, distinto de un agente que nunca
 *  se ha invocado. */
async function tieneCorridasEsteMes(db: DbClient, hotelId: string, agentName: string): Promise<boolean> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count from public.agent_run
     where hotel_id = $1 and agent_name = $2 and created_at >= date_trunc('month', now());`,
    [hotelId, agentName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- catálogo heterogéneo: cada tool trae su propio TInput, igual que buildToolExecutors() en lib/agentTools.ts.
function buildToolForName(name: string, deps: { db: DbClient; agentName: string }): ToolDefinition<any> {
  switch (name) {
    case "crear_tarea_housekeeping":
      return createHousekeepingTaskTool({ db: deps.db });
    case "crear_ticket_mantenimiento":
      return createMaintenanceTicketTool({ db: deps.db });
    case "enviar_mensaje_whatsapp_plantilla":
      return createSendWhatsappTemplateTool({ db: deps.db, messaging: sharedWhatsappAdapter, simulated: true });
    case "registrar_evento_roi":
      return createRegistrarEventoRoiTool({ db: deps.db, agentName: deps.agentName });
    default:
      // Catálogo cerrado (REQ-AGT-018, patrón registry): un nombre de tool en
      // AGENT_DEFINITIONS que no tenga fábrica aquí es un error de configuración, nunca
      // algo que deba fallar en silencio o ejecutar una tool a medias.
      throw new Error(`No hay fábrica registrada para la tool "${name}" en el catálogo de agentes (H7).`);
  }
}

function buildToolRegistry(def: AgentDefinition, db: DbClient): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of def.toolNames) {
    registry.register(buildToolForName(name, { db, agentName: def.name }));
  }
  return registry;
}

/** Guion determinista de demo (FakeProvider, sin red/LLM real): recorrido de check-in
 * con incidencia para `recepcion_virtual`, clasificación fija para `enrutador_mensajes`
 * y registro de valor fijo para `auditor_nocturno`. El MISMO guion corre en cualquier
 * gate -- lo que cambia entre gates es si `AgentRunner` ejecuta de verdad cada tool
 * (ver runner.ts: en "shadow" ninguna tool write/external/money se ejecuta). */
function buildDemoScript(agentName: string, roomCode: string): FakeStep[] {
  if (agentName === "recepcion_virtual") {
    return [
      { kind: "tool_calls", calls: [{ name: "crear_tarea_housekeeping", input: { roomCode, priority: "alta" } }] },
      {
        kind: "tool_calls",
        calls: [
          {
            name: "crear_ticket_mantenimiento",
            input: {
              roomCode,
              title: "Aire acondicionado no enfría (demo)",
              description: "El huésped reporta que el aire acondicionado no enfría durante el check-in.",
              severity: "alta",
            },
          },
        ],
      },
      {
        kind: "tool_calls",
        calls: [
          {
            name: "enviar_mensaje_whatsapp_plantilla",
            input: { guestPhone: "+5215500000000", templateName: "checkin_confirmado", parameters: ["Huésped demo"] },
          },
        ],
      },
      {
        kind: "tool_calls",
        calls: [
          {
            name: "registrar_evento_roi",
            input: {
              tipoEvento: "checkin_asistido_con_incidencia",
              montoEstimado: 8.5,
              metodoContrafactual:
                "Minutos de staff de recepción/housekeeping ahorrados al resolver la incidencia sin llamada telefónica, a tarifa horaria del hotel (H17, agente de recepción virtual).",
              confianza: 0.6,
              supuestoVersion: "H17-v1",
              referenciaTipo: "tarea",
            },
          },
        ],
      },
      {
        kind: "final",
        text:
          "Demo: check-in registrado con incidencia de aire acondicionado. Se creó la tarea de housekeeping, " +
          "el ticket de mantenimiento, se confirmó por WhatsApp y se registró el valor estimado generado.",
      },
    ];
  }
  if (agentName === "enrutador_mensajes") {
    return [{ kind: "final", text: "Clasificación (demo): idioma=es, intención=incidencia_habitacion, área=housekeeping." }];
  }
  return [
    {
      kind: "tool_calls",
      calls: [
        {
          name: "registrar_evento_roi",
          input: {
            tipoEvento: "revenue_ajuste_nocturno_detectado",
            montoEstimado: 42,
            metodoContrafactual:
              "Diferencia entre la tarifa efectivamente aplicada y la tarifa objetivo del pickup del día, sobre el cierre nocturno (H17, agente de revenue).",
            confianza: 0.5,
            supuestoVersion: "H17-v1",
            referenciaTipo: "ninguna",
          },
        },
      ],
    },
    { kind: "final", text: "Demo: cierre nocturno revisado, valor estimado registrado (sin cambios de tarifa -- eso requiere aprobación humana)." },
  ];
}

export function agentesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/agentes*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));

  app.get("/hoteles/:hotelId/agentes", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const out = [];
    for (const def of listAgentDefinitions()) {
      const config = await resolveAgentConfig(db, hotelId, def);
      out.push({
        agente: def.name,
        etiqueta: def.label,
        descripcion: def.description,
        rolModelo: def.role,
        rolesPermitidos: def.allowedStaffRoles,
        gate: config.gate,
        techoMensualUsd: config.monthlyCeilingUsd,
        moneda: config.currency,
        umbralAlertaPct: config.alertThresholdPct,
      });
    }
    return c.json(out);
  });

  app.get("/hoteles/:hotelId/agentes/costos", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const out = [];
    for (const def of listAgentDefinitions()) {
      const config = await resolveAgentConfig(db, hotelId, def);
      const consumido = await costoDelMes(db, hotelId, def.name);
      const huboCorridas = await tieneCorridasEsteMes(db, hotelId, def.name);
      const pctUsado = config.monthlyCeilingUsd > 0 ? consumido / config.monthlyCeilingUsd : 0;
      out.push({
        agente: def.name,
        etiqueta: def.label,
        gate: config.gate,
        techoMensualUsd: config.monthlyCeilingUsd,
        moneda: config.currency,
        consumidoUsd: consumido,
        pctUsado: Math.min(pctUsado, 1),
        umbralAlertaPct: config.alertThresholdPct,
        alerta: pctUsado >= config.alertThresholdPct,
        sinDatos: !huboCorridas,
      });
    }
    return c.json(out);
  });

  app.patch("/hoteles/:hotelId/agentes/:agente/config", async (c) => {
    assertRole(c, ["owner", "gm"] as HotelRole[]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const agente = c.req.param("agente");
    const def = getAgentDefinition(agente);
    if (!def) throw Errors.notFound(`No existe el agente "${agente}" en el catálogo.`);

    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));
    const current = await resolveAgentConfig(db, hotelId, def);
    const gate = body.gate ?? current.gate;
    const techo = body.techoMensualUsd ?? current.monthlyCeilingUsd;

    await db.query(
      `insert into public.agent_config (org_id, hotel_id, agent_name, gate, monthly_ceiling_usd)
       values ($1, $2, $3, $4, $5)
       on conflict (hotel_id, agent_name)
       do update set gate = excluded.gate, monthly_ceiling_usd = excluded.monthly_ceiling_usd, updated_at = now();`,
      [orgId, hotelId, def.name, gate, techo],
    );

    return c.json({ agente: def.name, gate, techoMensualUsd: techo });
  });

  app.post("/hoteles/:hotelId/agentes/:agente/ejecutar", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const agente = c.req.param("agente");
    const def = getAgentDefinition(agente);
    if (!def) throw Errors.notFound(`No existe el agente "${agente}" en el catálogo.`);

    // Defensa en profundidad (además de la RLS de agent_run/agent_config): un rol de
    // staff que no está en la lista permitida de ESTE agente nunca llega a construir el
    // ToolContext ni a gastar presupuesto -- ej. housekeeping no puede disparar el
    // auditor nocturno de revenue.
    assertRole(c, def.allowedStaffRoles as unknown as HotelRole[]);

    const body = parseBody(ejecutarSchema, await c.req.json().catch(() => ({})));

    // A5 (auditoria-2 agentico ALTO, REQ-AGT-020): serializa esta corrida contra
    // cualquier otra corrida CONCURRENTE del MISMO (hotel, agente) -- el advisory
    // lock es transaccional (se libera al COMMIT de esta transacción por-request,
    // que incluye tanto la corrida del agente como el INSERT de `agent_run` con el
    // costo real), así que una segunda petición concurrente espera a que la primera
    // termine y comitee su costo real antes de leer `costoDelMes()`. Sin esto, dos
    // corridas casi simultáneas podían ambas leer "restante > 0" antes de que
    // cualquiera registrara su gasto, y juntas rebasar el techo mensual configurado.
    // A5 (auditoria-2 agentico ALTO, REQ-AGT-020): serializa esta corrida contra
    // cualquier otra corrida CONCURRENTE del MISMO (hotel, agente) -- el advisory
    // lock es transaccional (se libera al COMMIT de esta transacción por-request,
    // que incluye tanto la corrida del agente como el INSERT de `agent_run` con el
    // costo real), así que una segunda petición concurrente espera a que la primera
    // termine y comitee su costo real antes de leer `costoDelMes()`. Sin esto, dos
    // corridas casi simultáneas podían ambas leer "restante > 0" antes de que
    // cualquiera registrara su gasto, y juntas rebasar el techo mensual configurado.
    await db.query("select public.lock_agent_budget($1, $2);", [hotelId, def.name]);

    const config = await resolveAgentConfig(db, hotelId, def);
    const consumidoAntes = await costoDelMes(db, hotelId, def.name);
    const restante = config.monthlyCeilingUsd - consumidoAntes;

    // Corte de presupuesto ANTES de invocar al proveedor (REQ-AGT-020): nunca se paga
    // una llamada de modelo "gratis" cuando el hotel ya agotó su techo mensual para este
    // agente. Se registra igual una fila de `agent_run` (costo 0, sin pasos) para que el
    // historial de corridas muestre HONESTAMENTE que se intentó y por qué se detuvo,
    // sin fabricar un runId de AgentRunner que nunca corrió.
    if (restante <= 0) {
      await db.query(
        `insert into public.agent_run
           (run_id, org_id, hotel_id, agent_name, model_role, provider_id, model_slug, gate, status,
            steps, tokens_in, tokens_out, cost_usd, request_id, actor_type, actor_id, duration_ms, message)
         values (gen_random_uuid(), $1, $2, $3, $4, 'ninguno', 'ninguno', $5, 'presupuesto_agotado',
                 0, 0, 0, 0, $6, $7, $8, 0, $9);`,
        [
          orgId,
          hotelId,
          def.name,
          def.role,
          config.gate,
          c.get("requestId"),
          "staff",
          c.get("userId"),
          `Presupuesto mensual de "${def.label}" agotado (USD ${config.monthlyCeilingUsd.toFixed(2)}, ya consumido USD ${consumidoAntes.toFixed(2)}); no se invocó al proveedor de modelo.`,
        ],
      );
      return c.json({
        estado: "presupuesto_agotado",
        mensaje: `El presupuesto mensual de este agente (USD ${config.monthlyCeilingUsd.toFixed(2)}) ya se agotó este mes; se detiene antes de llamar al proveedor de modelo.`,
        techoMensualUsd: config.monthlyCeilingUsd,
        consumidoUsd: consumidoAntes,
        gate: config.gate,
        simulado: false,
      });
    }

    const tools = buildToolRegistry(def, db);
    const approvalQueue = createTransactionalTemplateApprovalQueue(
      new PostgresApprovalQueue(db),
      transactionalTemplateCheckFromDb(db),
    );

    const modelSlug = resolveModelForRole(def.role);
    let provider: LlmProvider;
    if (body.demo) {
      // DEMO-101 es un código SINTÉTICO, no una habitación real del hotel (aud-2
      // agentico CRÍTICO): antes se tomaba "el primer cuarto real por código
      // alfabético" de `public.room`, así que el guion de demo (que crea un ticket de
      // mantenimiento con severity:"alta") podía terminar marcando una habitación
      // VENDIBLE real como fuera de servicio si el gate del hotel ya no era "shadow".
      provider = new FakeProvider(buildDemoScript(def.name, "DEMO-101"), modelSlug);
    } else {
      // Sin credenciales reales en este entorno: se declara `no_configurado` de forma
      // honesta (ver agent-core provider.ts) -- nunca una respuesta simulada haciéndose
      // pasar por real.
      provider = new EnvProvider();
    }

    // aud-2 agentico CRÍTICO: la demo SIEMPRE corre en gate "shadow", sin importar el
    // gate real configurado para (hotel, agente) -- es la única garantía estructural
    // de que "Demo (simulada)" nunca ejecuta un efecto real (marcar una habitación
    // fuera de servicio, crear una tarea real, enviar un WhatsApp real, etc.) en un
    // hotel/agente que ya salió de shadow hacia "propone"/"autopilot". El MISMO guion
    // (buildDemoScript) sigue corriendo para cualquier agente -- lo que cambia es que
    // AgentRunner.run() (runner.ts) nunca llega a invocar `tool.run()` para ninguna
    // tool write/external/money mientras el gate efectivo sea "shadow".
    const gateEfectivo: AgentGate = body.demo ? "shadow" : config.gate;

    const pricing = def.role === "batch_nocturno" ? DEFAULT_BATCH_PRICING : DEFAULT_PRICING;
    const events: AgentTraceEvent[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;

    const ctx = buildToolContext(
      {
        orgId,
        hotelId,
        actor: { type: "staff", id: c.get("userId") },
        requestId: c.get("requestId"),
      },
      createRunBudget({ maxUsd: restante, maxMs: 60_000, maxTokens: 200_000 }),
    );

    // MEDIO (auditoria-2 agentico): REQ-AGT-005/REQ-AGT-016 (TTFT <600ms p50 en voz) --
    // `roleParamsForChannel()` (agent-core roles.ts) ya calculaba el effort correcto
    // por canal desde la ronda 1, pero ningún código de apps/api lo llamaba: el único
    // punto real de construcción de AgentRunner seguía usando `ROLE_PARAMS[def.role]`
    // a secas, ignorando `body.canal`. Ahora se resuelve aquí y se reenvía al
    // proveedor (provider.ts `LlmCompleteParams.effort`, agregado en este mismo fix).
    const roleParams = roleParamsForChannel(def.role, body.canal);

    const runner = new AgentRunner({
      agentName: def.name,
      provider,
      tools,
      approvalQueue,
      systemPrompt: def.systemPrompt,
      modelSlug,
      temperature: roleParams.temperature,
      effort: roleParams.effort,
      maxSteps: def.maxSteps,
      maxOutputTokensPerCall: def.maxOutputTokensPerCall,
      pricing,
      gate: gateEfectivo,
      disclosureMessage: def.disclosureMessage,
      onTrace: (event) => {
        events.push(event);
        if (event.kind === "llm_call") {
          tokensIn += event.tokensIn ?? 0;
          tokensOut += event.tokensOut ?? 0;
          costUsd += event.costUsd ?? 0;
        }
      },
    });

    const startedAt = Date.now();
    const result = await runner.run(ctx, body.mensaje);
    const durationMs = Date.now() - startedAt;

    // Trazas paso a paso -> audit_log, en ORDEN (la cadena de hash de record_audit_log
    // depende del orden de inserción) y dentro de la MISMA transacción por-request que
    // el INSERT de agent_run que sigue.
    for (const event of events) {
      await db.query("select public.record_audit_log($1, $2, $3, $4, $5, $6::jsonb);", [
        orgId,
        hotelId,
        `agente.${event.kind}`,
        "agent_run",
        null,
        JSON.stringify({
          agente: def.name,
          runId: event.runId,
          paso: event.step,
          modelo: event.modelSlug,
          tool: event.toolName,
          efecto: event.effect,
          gate: event.gate,
          tokensEntrada: event.tokensIn,
          tokensSalida: event.tokensOut,
          costoUsd: event.costUsd,
          mensaje: event.message,
        }),
      ]);
    }

    await db.query(
      `insert into public.agent_run
         (run_id, org_id, hotel_id, agent_name, model_role, provider_id, model_slug, gate, status,
          steps, tokens_in, tokens_out, cost_usd, request_id, actor_type, actor_id, duration_ms, message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18);`,
      [
        result.runId,
        orgId,
        hotelId,
        def.name,
        def.role,
        provider.id,
        modelSlug,
        gateEfectivo,
        result.status,
        result.steps,
        tokensIn,
        tokensOut,
        costUsd,
        c.get("requestId"),
        "staff",
        c.get("userId"),
        durationMs,
        result.message,
      ],
    );

    deps.metrics.incrementAgentCost(hotelId, def.name, costUsd);

    return c.json({
      estado: result.status,
      mensaje: result.message,
      runId: result.runId,
      pasos: result.steps,
      tokensEntrada: tokensIn,
      tokensSalida: tokensOut,
      costoUsd: costUsd,
      gate: gateEfectivo,
      aprobacionesPendientes: result.pendingApprovalIds,
      simulado: provider.id === "fake",
      modelo: modelSlug,
    });
  });

  return app;
}
