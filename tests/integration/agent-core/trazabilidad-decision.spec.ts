// REQ-AGT-007 (H19-011/OBS): "El sistema debe mantener trazabilidad/explicabilidad de
// toda decisión de un agente que afecte económica o legalmente al huésped (p.ej. negar
// reembolso, aplicar cargo), con registro de la regla/prompt que la originó, verificable
// ante el huésped y ante la autoridad." Verificado: reconstruyendo una decisión desde su
// registro.
//
// Gap real que este archivo cierra: antes de este cambio, el `tool_call` de una tool
// económica (`effect==="money"`, mismo marcador que ya usa REQ-AGT-003 para "acción con
// valor económico") solo dejaba en `audit_log` el NOMBRE de la tool y el `result.summary`
// genérico de la propia tool (p.ej. "Gasto autorizado") -- sin el INPUT real con el que
// se tomó la decisión (monto, folio...) ni bajo qué versión de las instrucciones del
// agente (`systemPrompt`) se produjo. Desde ese registro no se podía reconstruir "qué se
// decidió, con qué datos, bajo qué regla" -- ni para el huésped ni para una autoridad que
// audite después, solo el resultado final. `AgentTraceEvent.toolInput`/`.promptVersion`
// (agent-core `trace.ts`) + `computeSystemPromptVersion()` cierran ese gap: `AgentRunner`
// (runner.ts) los adjunta AUTOMÁTICAMENTE a cada `tool_call` de una tool
// `effect==="money"` (o `isPriceOrEmission`), sin depender de que el modelo decida
// declararlos aparte -- mismo espíritu estructural que REQ-AGT-003.
//
// Este archivo verifica, contra `embedded-postgres` REAL (ADR-003) y con el MISMO código
// de persistencia que usa `apps/api/src/routes/agentes.ts` en producción
// (`persistAgentTraceEvents`, `apps/api/src/lib/agentObservability.ts` -- nunca una
// reimplementación paralela del INSERT), que una decisión económica real
// (`autorizar_gasto_mantenimiento`, la única tool `effect="money"` real del catálogo,
// mismo insumo que ya usa `tests/integration/agent-core/roi-event-cobertura.spec.ts`) se
// puede reconstruir POR COMPLETO leyendo solo su fila de `audit_log`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunner,
  FakeProvider,
  InMemoryCostLedger,
  PostgresApprovalQueue,
  ToolRegistry,
  buildToolContext,
  computeSystemPromptVersion,
  createAuthorizeMaintenanceExpenseTool,
  createMaintenanceTicketTool,
  createPostgresRoiEventRecorder,
  createRunBudget,
  type AgentRunResult,
  type AgentTraceEvent,
  type ApprovalQueue,
  type FakeStep,
  type ToolContext,
  type ToolRegistry as ToolRegistryType,
} from "@atiende-hoteles/agent-core";
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";
import { persistAgentTraceEvents } from "../../../apps/api/src/lib/agentObservability.ts";

let engine: EmbeddedPostgresEngine;
let seed: SeedResult;
let hotelId: string;
let orgId: string;
let roomCode: string;

const SYSTEM_PROMPT =
  "Eres el agente de recepción de un hotel independiente. Nunca decides precio ni tarifa por tu cuenta.";

beforeAll(async () => {
  engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  seed = await seedDev(engine.admin);
  hotelId = seed.hotels[0]!.id;
  orgId = seed.orgId;

  const { rows } = await engine.admin.query<{ code: string }>(
    "select code from public.room where hotel_id = $1 order by code limit 1;",
    [hotelId],
  );
  roomCode = rows[0]!.code;
});

afterAll(async () => {
  await engine.stop();
});

afterEach(async () => {
  await engine.admin.exec(
    `truncate table public.agent_approval_confirmation, public.agent_approval, public.audit_log,
       public.roi_event, public.maintenance_ticket
     restart identity cascade;`,
  );
});

function ctxFor(requestId: string): ToolContext {
  return buildToolContext(
    {
      orgId,
      hotelId,
      actor: { type: "staff" as const, id: seed.hotels[0]!.staff.find((s) => s.role === "maintenance")!.id },
      requestId,
    },
    createRunBudget({}),
  );
}

/** `AgentRunner` real con el MISMO `systemPrompt` en toda la corrida (para que el hash de
 * `promptVersion` sea comparable entre la corrida y lo que este archivo recalcula
 * directamente). Incluye `roiEventRecorder` real (REQ-AGT-003, ya probada aparte en
 * `roi-event-cobertura.spec.ts`) porque sin él la ÚNICA tool `effect="money"` real del
 * catálogo se cierra `roi_event_faltante` en vez de "completado" -- REQ-AGT-007 no
 * verifica la cobertura de ROI en sí, pero necesita una corrida que SÍ complete para
 * poder reconstruir la decisión ya cerrada. */
function buildRunner(script: readonly FakeStep[], tools: ToolRegistryType, approvalQueue: ApprovalQueue): AgentRunner {
  return new AgentRunner({
    agentName: "recepcion",
    provider: new FakeProvider(script),
    tools,
    approvalQueue,
    systemPrompt: SYSTEM_PROMPT,
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 4,
    pricing: {},
    gate: "propone",
    costLedger: new InMemoryCostLedger(),
    roiEventRecorder: createPostgresRoiEventRecorder(engine.admin),
  });
}

async function crearTicket(ctx: ToolContext, title: string): Promise<string> {
  const tools = new ToolRegistry();
  tools.register(createMaintenanceTicketTool({ db: engine.admin }));
  const approvalQueue = new PostgresApprovalQueue(engine.admin);
  const runner = buildRunner(
    [
      {
        kind: "tool_calls",
        calls: [
          {
            name: "crear_ticket_mantenimiento",
            input: { roomCode, title, description: "Reportado para prueba de trazabilidad.", severity: "media" },
          },
        ],
      },
      { kind: "final", text: "Ticket creado." },
    ],
    tools,
    approvalQueue,
  );
  const result = await runner.run(ctx, `Reporta: ${title}`);
  expect(result.status).toBe("completado");
  const { rows } = await engine.admin.query<{ id: string }>(
    "select id from public.maintenance_ticket where hotel_id = $1 and title = $2;",
    [hotelId, title],
  );
  return rows[0]!.id;
}

/** Doble confirmación (GOB-026) de `autorizar_gasto_mantenimiento` sobre un ticket ya
 * creado -- mismo patrón que `roi-event-cobertura.spec.ts`. Devuelve tanto el
 * `AgentRunResult` de la corrida que ejecuta la tool como los `AgentTraceEvent` que
 * capturó, listos para persistir con el código real de producción. */
async function autorizarGasto(
  ctx: ToolContext,
  ticketId: string,
  actualCost: number,
): Promise<{ result: AgentRunResult; events: AgentTraceEvent[] }> {
  const tools = new ToolRegistry();
  tools.register(createAuthorizeMaintenanceExpenseTool({ db: engine.admin }));
  const approvalQueue = new PostgresApprovalQueue(engine.admin);
  const script: FakeStep[] = [
    { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost } }] },
    { kind: "final", text: "Gasto autorizado." },
  ];

  const first = await buildRunner(script, tools, approvalQueue).run(ctx, "Autoriza el gasto del ticket.");
  expect(first.status).toBe("esperando_aprobacion");
  const approvalId = first.pendingApprovalIds[0]!;

  const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
  const gm = seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
  await approvalQueue.decide({ approvalId, actor: owner.id, role: "owner", decision: "aprobar", textoExacto: "Autorizo el gasto." });
  const decided = await approvalQueue.decide({ approvalId, actor: gm.id, role: "gm", decision: "aprobar", textoExacto: "Autorizo el gasto." });
  expect(decided.status).toBe("aprobada");

  const events: AgentTraceEvent[] = [];
  const result = await new AgentRunner({
    agentName: "recepcion",
    provider: new FakeProvider(script),
    tools,
    approvalQueue,
    systemPrompt: SYSTEM_PROMPT,
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 4,
    pricing: {},
    gate: "propone",
    roiEventRecorder: createPostgresRoiEventRecorder(engine.admin),
    onTrace: (event) => events.push(event),
  }).run(ctx, "Autoriza el gasto del ticket.");

  return { result, events };
}

describe("REQ-AGT-007: trazabilidad/explicabilidad de una decisión económica de agente (AgentRunner + Postgres real)", () => {
  it("una decisión económica APROBADA (autorizar_gasto_mantenimiento) se reconstruye por completo desde su fila de audit_log: input real + regla/prompt + resultado", async () => {
    const ctx = ctxFor("req-trazabilidad-aprobada");
    const ticketId = await crearTicket(ctx, "Fuga de agua (trazabilidad)");

    const { result, events } = await autorizarGasto(ctx, ticketId, 1420.5);
    expect(result.status).toBe("completado");

    await persistAgentTraceEvents({ db: engine.admin, orgId, hotelId, agentName: "recepcion", events });

    const { rows } = await engine.admin.query<{
      payload: {
        tool: string;
        efecto: string;
        mensaje: string;
        inputHerramienta: string;
        versionPrompt: string;
      };
    }>(
      `select payload from public.audit_log
       where action = 'agente.tool_call' and payload->>'tool' = 'autorizar_gasto_mantenimiento'
         and payload::text ilike $1
       order by created_at desc limit 1;`,
      [`%${ticketId}%`],
    );
    expect(rows).toHaveLength(1);
    const registro = rows[0]!.payload;

    // 1) QUÉ se decidió y con qué datos exactos -- el input real que el modelo propuso,
    // no solo el nombre de la tool.
    expect(registro.efecto).toBe("money");
    expect(registro.inputHerramienta).toContain(ticketId);
    expect(registro.inputHerramienta).toContain("1420.5");
    const inputReconstruido = JSON.parse(registro.inputHerramienta) as { ticketId: string; actualCost: number };
    expect(inputReconstruido.ticketId).toBe(ticketId);
    expect(inputReconstruido.actualCost).toBe(1420.5);

    // 2) BAJO QUÉ REGLA/PROMPT -- el hash debe coincidir con el que CUALQUIERA (huésped,
    // autoridad) puede recalcular a partir del `systemPrompt` real del agente en esa
    // fecha (aquí, el mismo texto que usó `buildRunner`/`autorizarGasto`).
    expect(registro.versionPrompt).toBe(computeSystemPromptVersion(SYSTEM_PROMPT));
    expect(registro.versionPrompt).toMatch(/^[0-9a-f]{64}$/);

    // 3) El resultado de la decisión (aprobada/ejecutada) sigue en `mensaje`, como ya
    // exigía REQ-AGT-006.
    expect(registro.mensaje).toMatch(/autorizad[oa]|cerrado/i);
  });

  it("una decisión económica DENEGADA (ticket inexistente) es IGUAL de trazable: input + regla/prompt quedan registrados aunque la acción se rechace -- caso negativo", async () => {
    const ctx = ctxFor("req-trazabilidad-denegada");
    // UUID sintético con letras hex reales (nunca solo dígitos): un ticketId puramente
    // numérico caería en el patrón de número de tarjeta de `redact()` (CARD_RE, 12-18
    // dígitos con separadores) y el registro persistido dejaría de contener el valor
    // exacto -- redactado como si fuera PII, aunque sea un identificador interno, no un
    // dato del huésped. Usar un UUID hex real evita ese falso positivo del propio
    // redactor y prueba el criterio real (reconstrucción exacta del input).
    const ticketIdInexistente = "0000aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const { result, events } = await autorizarGasto(ctx, ticketIdInexistente, 500);
    // La tool corre (la aprobación humana ya se dio sobre ESTE input) pero `run()`
    // devuelve `ok:false` porque el ticket no existe en este hotel -- una decisión que
    // NIEGA la acción, análoga a "negar un reembolso": debe quedar tan trazable como una
    // que sí ejecuta.
    expect(result.status).toBe("completado");

    await persistAgentTraceEvents({ db: engine.admin, orgId, hotelId, agentName: "recepcion", events });

    const { rows } = await engine.admin.query<{
      payload: { mensaje: string; inputHerramienta: string; versionPrompt: string };
    }>(
      `select payload from public.audit_log
       where action = 'agente.tool_call' and payload->>'tool' = 'autorizar_gasto_mantenimiento'
         and payload::text ilike $1
       order by created_at desc limit 1;`,
      [`%${ticketIdInexistente}%`],
    );
    expect(rows).toHaveLength(1);
    const registro = rows[0]!.payload;

    expect(registro.mensaje).toMatch(/no existe/i);
    const inputReconstruido = JSON.parse(registro.inputHerramienta) as { ticketId: string };
    expect(inputReconstruido.ticketId).toBe(ticketIdInexistente);
    expect(registro.versionPrompt).toBe(computeSystemPromptVersion(SYSTEM_PROMPT));
  });

  it("un cambio en el systemPrompt del agente produce un promptVersion DISTINTO -- el hash está atado al texto real de la regla, no es un valor fijo", async () => {
    const ctx = ctxFor("req-trazabilidad-prompt-distinto");
    const ticketId = await crearTicket(ctx, "Chapa dañada (prompt distinto)");

    const tools = new ToolRegistry();
    tools.register(createAuthorizeMaintenanceExpenseTool({ db: engine.admin }));
    const approvalQueue = new PostgresApprovalQueue(engine.admin);
    const script: FakeStep[] = [
      { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost: 300 } }] },
      { kind: "final", text: "Gasto autorizado." },
    ];
    const first = await new AgentRunner({
      agentName: "recepcion",
      provider: new FakeProvider(script),
      tools,
      approvalQueue,
      systemPrompt: SYSTEM_PROMPT,
      modelSlug: "claude-sonnet-5",
      temperature: 0,
      maxSteps: 4,
      pricing: {},
      gate: "propone",
    }).run(ctx, "Autoriza el gasto.");
    const approvalId = first.pendingApprovalIds[0]!;
    const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    const gm = seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
    await approvalQueue.decide({ approvalId, actor: owner.id, role: "owner", decision: "aprobar", textoExacto: "Autorizo." });
    await approvalQueue.decide({ approvalId, actor: gm.id, role: "gm", decision: "aprobar", textoExacto: "Autorizo." });

    const promptDistinto = `${SYSTEM_PROMPT} (v2: agrega una regla nueva)`;
    const events: AgentTraceEvent[] = [];
    await new AgentRunner({
      agentName: "recepcion",
      provider: new FakeProvider(script),
      tools,
      approvalQueue,
      systemPrompt: promptDistinto,
      modelSlug: "claude-sonnet-5",
      temperature: 0,
      maxSteps: 4,
      pricing: {},
      gate: "propone",
      onTrace: (event) => events.push(event),
    }).run(ctx, "Autoriza el gasto.");

    const toolCallEvent = events.find((e) => e.kind === "tool_call" && e.toolName === "autorizar_gasto_mantenimiento");
    expect(toolCallEvent?.promptVersion).toBe(computeSystemPromptVersion(promptDistinto));
    expect(toolCallEvent?.promptVersion).not.toBe(computeSystemPromptVersion(SYSTEM_PROMPT));
  });

  it("una tool SIN valor económico (crear_ticket_mantenimiento, effect=\"write\") NO adjunta toolInput/promptVersion -- el alcance es económico/legal, no cualquier tool_call", async () => {
    const ctx = ctxFor("req-trazabilidad-fuera-de-alcance");
    const events: AgentTraceEvent[] = [];
    const tools = new ToolRegistry();
    tools.register(createMaintenanceTicketTool({ db: engine.admin }));
    const approvalQueue = new PostgresApprovalQueue(engine.admin);
    const runner = new AgentRunner({
      agentName: "recepcion",
      provider: new FakeProvider([
        {
          kind: "tool_calls",
          calls: [
            {
              name: "crear_ticket_mantenimiento",
              input: { roomCode, title: "Foco fundido", description: "Reportado.", severity: "baja" },
            },
          ],
        },
        { kind: "final", text: "Ticket creado." },
      ]),
      tools,
      approvalQueue,
      systemPrompt: SYSTEM_PROMPT,
      modelSlug: "claude-sonnet-5",
      temperature: 0,
      maxSteps: 4,
      pricing: {},
      gate: "propone",
      onTrace: (event) => events.push(event),
    });
    const result = await runner.run(ctx, "Reporta un foco fundido.");
    expect(result.status).toBe("completado");

    const toolCallEvent = events.find((e) => e.kind === "tool_call" && e.toolName === "crear_ticket_mantenimiento");
    expect(toolCallEvent?.effect).toBe("write");
    expect(toolCallEvent?.toolInput).toBeUndefined();
    expect(toolCallEvent?.promptVersion).toBeUndefined();
  });

  it("computeSystemPromptVersion() es determinista y sensible a cualquier cambio de texto (verificabilidad ante huésped/autoridad sin depender de la corrida)", () => {
    const a = computeSystemPromptVersion("Eres el agente de recepción.");
    const b = computeSystemPromptVersion("Eres el agente de recepción.");
    const c = computeSystemPromptVersion("Eres el agente de recepción!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
