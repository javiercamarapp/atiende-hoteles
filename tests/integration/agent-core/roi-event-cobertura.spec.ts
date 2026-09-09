// REQ-AGT-003 (H17-001/BP-131/GOB-037): "El sistema debe registrar un `ROIEvent` (monto
// verificado, monto estimado, método contrafactual, confianza) en cada acción con valor
// económico, sin excepción." Verificado: 0 acciones económicas sin `ROIEvent` asociado
// en un lote de prueba.
//
// Antes de este archivo, la ÚNICA forma de que un `ROIEvent` quedara registrado era que
// el modelo decidiera llamar aparte la tool "registrar_evento_roi" (`roiTools.ts`) --
// una tool más del catálogo que el modelo puede simplemente no llamar. Eso deja el
// "sin excepción" del requisito en manos del modelo, no del núcleo -- exactamente lo que
// `docs/REQUISITOS.md` marcaba como `pendiente`.
//
// Este archivo verifica, contra un `embedded-postgres` REAL (ADR-003) con
// `PostgresApprovalQueue` real (no un mock), el mecanismo ESTRUCTURAL que agrega este
// cambio: `AgentRunner` (runner.ts) registra AUTOMÁTICAMENTE el `ROIEvent` de TODA tool
// `effect="money"` que ejecuta con éxito -- vía `tool.deriveRoiEvent()` (tool.ts, código
// determinista de la propia tool, nunca del modelo) + `roiEventRecorder`
// (`createPostgresRoiEventRecorder`, roiTools.ts) -- y se cierra explícitamente
// `roi_event_faltante` (nunca "completado" en silencio) cuando esa cobertura no se puede
// garantizar. La única tool `effect="money"` real de este catálogo hoy,
// `autorizar_gasto_mantenimiento` (housekeepingTools.ts), es la que se ejerce aquí.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentRunner,
  FakeProvider,
  InMemoryCostLedger,
  PostgresApprovalQueue,
  ToolRegistry,
  buildToolContext,
  createAuthorizeMaintenanceExpenseTool,
  createMaintenanceTicketTool,
  createPostgresRoiEventRecorder,
  createRunBudget,
  defineTool,
  type AgentRunResult,
  type ApprovalQueue,
  type FakeStep,
  type ToolContext,
  type ToolDefinition,
} from "@atiende-hoteles/agent-core";
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";

let engine: EmbeddedPostgresEngine;
let seed: SeedResult;
let hotelId: string;
let roomCode: string;

beforeAll(async () => {
  engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  seed = await seedDev(engine.admin);
  hotelId = seed.hotels[0]!.id;

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
  // Cada `it` corre su propio lote independiente sobre la MISMA base (mismo criterio que
  // journey-checkin-incidencia.spec.ts) -- se limpian las tablas que este archivo toca
  // para que un caso no contamine el conteo de `roi_event` del siguiente.
  await engine.admin.exec(
    `truncate table public.agent_approval_confirmation, public.agent_approval,
       public.roi_event, public.maintenance_ticket
     restart identity cascade;`,
  );
});

function ctxFor(requestId: string): ToolContext {
  return buildToolContext(
    {
      orgId: seed.orgId,
      hotelId,
      actor: { type: "staff" as const, id: seed.hotels[0]!.staff.find((s) => s.role === "maintenance")!.id },
      requestId,
    },
    createRunBudget({}),
  );
}

/** `AgentRunner` real con la MISMA `ApprovalQueue` que el llamador pase (para poder
 * decidir una aprobación entre dos corridas, igual que el journey de check-in) y, salvo
 * que se sobreescriba explícitamente, el `RoiEventRecorder` real contra Postgres --
 * exactamente el wiring que usa `apps/api/src/routes/agentes.ts`. */
function buildRunner(
  script: readonly FakeStep[],
  tools: ToolRegistry,
  approvalQueue: ApprovalQueue,
  overrides: { roiEventRecorder?: ReturnType<typeof createPostgresRoiEventRecorder> | undefined } = {},
): AgentRunner {
  return new AgentRunner({
    agentName: "recepcion",
    provider: new FakeProvider(script),
    tools,
    approvalQueue,
    systemPrompt: "Eres el agente de recepción de un hotel.",
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 4,
    pricing: {},
    gate: "propone",
    costLedger: new InMemoryCostLedger(),
    roiEventRecorder: "roiEventRecorder" in overrides ? overrides.roiEventRecorder : createPostgresRoiEventRecorder(engine.admin),
  });
}

/** Crea un ticket de mantenimiento real (severidad media, no bloquea la habitación) y
 * devuelve su id -- insumo de cada acción económica que se autoriza después. */
async function crearTicket(ctx: ToolContext, title: string, estimatedCost: number): Promise<string> {
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
            input: { roomCode, title, description: "Reportado para prueba de cobertura de ROI.", severity: "media", estimatedCost },
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
 * creado, con la MISMA `ApprovalQueue` real en las dos corridas (idéntico patrón al
 * journey de check-in: 1a corrida deja "esperando_aprobacion", dos roles distintos
 * deciden "aprobar", 2a corrida con la MISMA tool+input SÍ ejecuta). Devuelve el
 * `AgentRunResult` de la corrida que en verdad ejecuta la tool. */
async function autorizarGasto(
  ctx: ToolContext,
  ticketId: string,
  actualCost: number,
  overrides: { roiEventRecorder?: ReturnType<typeof createPostgresRoiEventRecorder> | undefined } = {},
): Promise<AgentRunResult> {
  const tools = new ToolRegistry();
  tools.register(createAuthorizeMaintenanceExpenseTool({ db: engine.admin }));
  const approvalQueue = new PostgresApprovalQueue(engine.admin);
  const script: FakeStep[] = [
    { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost } }] },
    { kind: "final", text: "Gasto autorizado." },
  ];

  const first = await buildRunner(script, tools, approvalQueue, overrides).run(ctx, "Autoriza el gasto del ticket.");
  expect(first.status).toBe("esperando_aprobacion");
  const approvalId = first.pendingApprovalIds[0]!;

  const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
  const gm = seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
  await approvalQueue.decide({ approvalId, actor: owner.id, role: "owner", decision: "aprobar", textoExacto: "Autorizo el gasto." });
  const decided = await approvalQueue.decide({ approvalId, actor: gm.id, role: "gm", decision: "aprobar", textoExacto: "Autorizo el gasto." });
  expect(decided.status).toBe("aprobada");

  return buildRunner(script, tools, approvalQueue, overrides).run(ctx, "Autoriza el gasto del ticket.");
}

describe("REQ-AGT-003: cobertura de ROIEvent en acciones con valor económico (AgentRunner + Postgres real)", () => {
  it("un LOTE de 3 acciones económicas reales (autorizar_gasto_mantenimiento) queda con su ROIEvent -- 0 sin cobertura", async () => {
    const ctx = ctxFor("req-roi-lote-1");

    // Antes de cualquier acción económica: la creación de tickets (effect="write", sin
    // valor económico propio) NO debe producir ningún ROIEvent.
    const ticketA = await crearTicket(ctx, "Fuga de agua A", 1500);
    const ticketB = await crearTicket(ctx, "Aire acondicionado B", 4200.5);
    const ticketC = await crearTicket(ctx, "Chapa de puerta C", 300);
    const { rows: antesDeAutorizar } = await engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.roi_event where hotel_id = $1;",
      [hotelId],
    );
    expect(Number(antesDeAutorizar[0]!.count)).toBe(0);

    const lote: Array<{ ticketId: string; actualCost: number }> = [
      { ticketId: ticketA, actualCost: 1420 },
      { ticketId: ticketB, actualCost: 4300.75 },
      { ticketId: ticketC, actualCost: 280 },
    ];

    for (const accion of lote) {
      const resultado = await autorizarGasto(ctx, accion.ticketId, accion.actualCost);
      // La acción económica en sí se reporta "completado" -- el registro del ROIEvent
      // ocurrió DENTRO de esa misma corrida, antes de que el runner siguiera adelante.
      expect(resultado.status).toBe("completado");
    }

    const { rows: eventos } = await engine.admin.query<{
      referencia_codigo: string;
      monto_estimado: string | null;
      monto_verificado: string | null;
      metodo_contrafactual: string;
      confianza: string;
      estimado: boolean;
      agent_name: string;
      tipo_evento: string;
      referencia_tipo: string;
    }>(
      `select referencia_codigo, monto_estimado, monto_verificado, metodo_contrafactual, confianza,
              estimado, agent_name, tipo_evento, referencia_tipo
       from public.roi_event where hotel_id = $1 order by created_at asc;`,
      [hotelId],
    );

    // El criterio literal: 0 acciones económicas del lote sin su ROIEvent asociado --
    // exactamente un evento por cada una de las 3 acciones, ni de más ni de menos.
    expect(eventos).toHaveLength(lote.length);
    for (const accion of lote) {
      const evento = eventos.find((e) => e.referencia_codigo === accion.ticketId);
      expect(evento, `falta el ROIEvent del ticket ${accion.ticketId}`).toBeDefined();
      // Los 4 campos que exige el criterio, sin excepción:
      expect(Number(evento!.monto_verificado)).toBeCloseTo(accion.actualCost, 2);
      expect(evento!.monto_estimado).toBeNull();
      expect(evento!.metodo_contrafactual.length).toBeGreaterThan(0);
      const confianza = Number(evento!.confianza);
      expect(confianza).toBeGreaterThanOrEqual(0);
      expect(confianza).toBeLessThanOrEqual(1);
      // `estimado` es una columna DERIVADA (trigger 0026): con monto_verificado presente
      // debe quedar en `false`, nunca confiar en lo que la app hubiera podido mandar.
      expect(evento!.estimado).toBe(false);
      expect(evento!.agent_name).toBe("recepcion");
      expect(evento!.tipo_evento).toBe("gasto_mantenimiento_autorizado");
      expect(evento!.referencia_tipo).toBe("tarea");
    }
  });

  it("fail-closed: una tool effect=\"money\" SIN deriveRoiEvent que ejecuta con éxito NO se reporta 'completado' -- se cierra 'roi_event_faltante' y no queda ningún ROIEvent", async () => {
    const ctx = ctxFor("req-roi-sin-derive");

    // Tool de dinero deliberadamente incompleta (a propósito de esta prueba, no del
    // catálogo real): declara effect="money"/needsApproval:true como exige GOB-026, pero
    // NO declara `deriveRoiEvent` -- el defecto exacto que REQ-AGT-003 debe atrapar.
    const cobrarSinRoiInput = z.object({ montoMxn: z.number().positive() });
    const cobrarSinRoiTool: ToolDefinition<z.infer<typeof cobrarSinRoiInput>> = defineTool({
      name: "cobrar_sin_roi_prueba",
      description: "Tool de prueba que mueve dinero pero no declara deriveRoiEvent.",
      inputSchema: cobrarSinRoiInput,
      effect: "money",
      needsApproval: true,
      run: () => ({ ok: true, summary: "Cobrado (sin ROIEvent declarado)." }),
    });

    const tools = new ToolRegistry();
    tools.register(cobrarSinRoiTool);
    const approvalQueue = new PostgresApprovalQueue(engine.admin);
    const script: FakeStep[] = [
      { kind: "tool_calls", calls: [{ name: "cobrar_sin_roi_prueba", input: { montoMxn: 999 } }] },
      { kind: "final", text: "Cobrado." },
    ];

    const first = await buildRunner(script, tools, approvalQueue).run(ctx, "Cobra el monto.");
    expect(first.status).toBe("esperando_aprobacion");
    const approvalId = first.pendingApprovalIds[0]!;
    const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    const gm = seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
    await approvalQueue.decide({ approvalId, actor: owner.id, role: "owner", decision: "aprobar", textoExacto: "Autorizo." });
    await approvalQueue.decide({ approvalId, actor: gm.id, role: "gm", decision: "aprobar", textoExacto: "Autorizo." });

    const segundo = await buildRunner(script, tools, approvalQueue).run(ctx, "Cobra el monto.");

    // Nunca "completado" a secas: la tool SÍ se ejecutó (movió "dinero"), pero sin forma
    // de registrar su ROIEvent la corrida se cierra explícitamente, nunca en silencio.
    expect(segundo.status).toBe("roi_event_faltante");
    expect(segundo.message).toMatch(/ROIEvent/);
    expect(segundo.pendingApprovalIds).toHaveLength(0);

    const { rows } = await engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.roi_event where hotel_id = $1;",
      [hotelId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it("defensa en profundidad: la tool REAL del catálogo (autorizar_gasto_mantenimiento) ejecutada SIN roiEventRecorder configurado también se cierra 'roi_event_faltante' -- nunca 'completado' sin cobertura de ROI", async () => {
    const ctx = ctxFor("req-roi-sin-recorder");
    const ticketId = await crearTicket(ctx, "Boiler descompuesto", 2000);

    // El wiring de apps/api (createPostgresRoiEventRecorder) se "olvida" a propósito en
    // esta corrida -- exactamente el escenario de un agente nuevo cuyo dueño agregó
    // "autorizar_gasto_mantenimiento" a su catálogo sin conectar el recorder.
    const resultado = await autorizarGasto(ctx, ticketId, 1900, { roiEventRecorder: undefined });

    expect(resultado.status).toBe("roi_event_faltante");
    expect(resultado.message).toMatch(/ROIEvent/);

    // La mutación real (cerrar el ticket con su costo) YA ocurrió -- esta corrida no la
    // revierte, documentado explícitamente en runner.ts: lo único que falta es la
    // cobertura de ROI, y por eso NUNCA se reporta como si nada hubiera faltado.
    const { rows: ticketRows } = await engine.admin.query<{ status: string; actual_cost: string }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(ticketRows[0]!.status).toBe("cerrado");
    expect(Number(ticketRows[0]!.actual_cost)).toBeCloseTo(1900, 2);

    const { rows: eventos } = await engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.roi_event where hotel_id = $1;",
      [hotelId],
    );
    expect(Number(eventos[0]!.count)).toBe(0);
  });

  it("una acción PENDIENTE de aprobación (nunca se ejecutó) no exige ningún ROIEvent -- la cobertura solo se evalúa sobre acciones que en verdad ocurrieron", async () => {
    const ctx = ctxFor("req-roi-pendiente");
    const ticketId = await crearTicket(ctx, "Filtración en plafón", 800);

    const tools = new ToolRegistry();
    tools.register(createAuthorizeMaintenanceExpenseTool({ db: engine.admin }));
    const approvalQueue = new PostgresApprovalQueue(engine.admin);
    const script: FakeStep[] = [
      { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost: 750 } }] },
      { kind: "final", text: "Esperando aprobación." },
    ];
    const resultado = await buildRunner(script, tools, approvalQueue).run(ctx, "Autoriza el gasto.");

    expect(resultado.status).toBe("esperando_aprobacion");
    const { rows: ticketRows } = await engine.admin.query<{ status: string; actual_cost: string | null }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    // Ninguna mutación real ocurrió todavía -- consistente con que tampoco haya ROIEvent.
    expect(ticketRows[0]!.status).not.toBe("cerrado");
    expect(ticketRows[0]!.actual_cost).toBeNull();

    const { rows: eventos } = await engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.roi_event where hotel_id = $1;",
      [hotelId],
    );
    expect(Number(eventos[0]!.count)).toBe(0);
  });
});
