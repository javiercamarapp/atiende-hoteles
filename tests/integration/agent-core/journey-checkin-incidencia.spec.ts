// H6b · Journey de punta a punta (REQ-HK-001/011/013/014, REQ-AGT-001/002/003, H09):
// durante el check-in de un huesped se detecta una incidencia (aire acondicionado), el
// agente crea la tarea de housekeeping + el ticket de mantenimiento, confirma por
// WhatsApp (plantilla transaccional, sin espera humana) y autoriza el gasto de reparacion
// (dinero, doble confirmacion de DOS roles distintos). Corre `AgentRunner` con
// `FakeProvider` (sin red, sin LLM real) en los 3 gates (`shadow`/`propone`/`autopilot`)
// contra un `embedded-postgres` real, usando las 4 tools de dominio + `PostgresApprovalQueue`
// + `FakeWhatsappAdapter` (packages/mcp-servers/whatsapp) tal cual quedaria conectado en
// apps/api -- ninguna llamada real a Meta/LLM.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunner,
  FakeProvider,
  InMemoryCostLedger,
  PostgresApprovalQueue,
  ToolRegistry,
  buildToolContext,
  createAuthorizeMaintenanceExpenseTool,
  createHousekeepingTaskTool,
  createMaintenanceTicketTool,
  createRunBudget,
  createSendWhatsappTemplateTool,
  createTransactionalTemplateApprovalQueue,
  transactionalTemplateCheckFromDb,
  type AgentGate,
  type FakeStep,
} from "@atiende-hoteles/agent-core";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
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

  await engine.admin.query(
    `insert into public.hotel_messaging_config (hotel_id, tenant_id, webhook_secret, transactional_templates)
     values ($1, $2, 'test-secret-simulado', array['checkin_confirmado']);`,
    [hotelId, seed.orgId],
  );

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
  // Cada `it` corre su propio recorrido independiente sobre la MISMA base -- se limpian
  // las tablas que el journey toca para que un gate no contamine al siguiente (misma
  // razon que tests/integration/agent-core/postgres-approval-queue.spec.ts).
  await engine.admin.exec(
    `truncate table public.agent_approval_confirmation, public.agent_approval,
       public.message, public.conversation, public.maintenance_ticket, public.housekeeping_task
     restart identity cascade;`,
  );
});

function buildRunner(gate: AgentGate, script: readonly FakeStep[]) {
  const tools = new ToolRegistry();
  const messaging = new FakeWhatsappAdapter();
  const deps = { db: engine.admin, messaging, simulated: true };

  tools.register(createHousekeepingTaskTool(deps));
  tools.register(createMaintenanceTicketTool(deps));
  tools.register(createAuthorizeMaintenanceExpenseTool(deps));
  tools.register(createSendWhatsappTemplateTool(deps));

  const approvalQueue = createTransactionalTemplateApprovalQueue(
    new PostgresApprovalQueue(engine.admin),
    transactionalTemplateCheckFromDb(engine.admin),
  );

  const runner = new AgentRunner({
    agentName: "recepcion",
    provider: new FakeProvider(script),
    tools,
    approvalQueue,
    systemPrompt: "Eres el agente de recepcion de un hotel.",
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 6,
    pricing: {},
    gate,
    costLedger: new InMemoryCostLedger(),
  });

  return { runner, approvalQueue };
}

function buildCtx(requestId: string) {
  return buildToolContext(
    {
      orgId: seed.orgId,
      hotelId,
      actor: { type: "staff" as const, id: seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!.id },
      requestId,
    },
    createRunBudget({}),
  );
}

describe("Journey check-in/incidencia · AgentRunner + FakeProvider (shadow/propone/autopilot)", () => {
  it("shadow: NINGUNA tool de escritura/externa se ejecuta (solo se registra la intencion)", async () => {
    const { runner } = buildRunner("shadow", [
      { kind: "tool_calls", calls: [{ name: "crear_tarea_housekeeping", input: { roomCode, priority: "alta" } }] },
      {
        kind: "tool_calls",
        calls: [
          {
            name: "crear_ticket_mantenimiento",
            input: { roomCode, title: "Aire acondicionado no enfría", description: "El huésped reporta que el AC no enfría.", severity: "alta" },
          },
        ],
      },
      { kind: "final", text: "Incidencia registrada en shadow (nada se ejecutó de verdad)." },
    ]);

    const ctx = buildCtx("req-journey-1");
    const result = await runner.run(ctx, "Huésped reporta AC descompuesto en su habitación al hacer check-in.");

    expect(result.status).toBe("completado");

    const { rows: tasks } = await engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
    const { rows: tickets } = await engine.admin.query("select id from public.maintenance_ticket where hotel_id = $1;", [hotelId]);
    expect(tasks).toHaveLength(0);
    expect(tickets).toHaveLength(0);
  });

  for (const gate of ["propone", "autopilot"] as const) {
    it(`${gate}: crea tarea + ticket, envía WhatsApp transaccional SIN espera humana, y detiene la autorización de gasto esperando aprobación`, async () => {
      const { runner } = buildRunner(gate, [
        { kind: "tool_calls", calls: [{ name: "crear_tarea_housekeeping", input: { roomCode, priority: "alta" } }] },
        {
          kind: "tool_calls",
          calls: [
            {
              name: "crear_ticket_mantenimiento",
              input: { roomCode, title: "Aire acondicionado no enfría", description: "El huésped reporta que el AC no enfría.", severity: "alta", estimatedCost: 4500 },
            },
          ],
        },
        {
          kind: "tool_calls",
          calls: [
            {
              name: "enviar_mensaje_whatsapp_plantilla",
              input: { guestPhone: "+5215500000000", templateName: "checkin_confirmado", parameters: ["Juan Pérez"] },
            },
          ],
        },
        { kind: "final", text: "Registrado y confirmado con el huésped." },
      ]);

      const ctx = buildCtx("req-journey-1");
      const result = await runner.run(ctx, "Huésped reporta AC descompuesto en su habitación al hacer check-in.");
      expect(result.status).toBe("completado");

      const { rows: tasks } = await engine.admin.query<{ id: string }>(
        "select id from public.housekeeping_task where hotel_id = $1;",
        [hotelId],
      );
      expect(tasks).toHaveLength(1);

      const { rows: tickets } = await engine.admin.query<{ id: string; marks_room_out_of_service: boolean }>(
        "select id, marks_room_out_of_service from public.maintenance_ticket where hotel_id = $1;",
        [hotelId],
      );
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.marks_room_out_of_service).toBe(true);

      // La plantilla "checkin_confirmado" es transaccional (hotel_messaging_config): se
      // envio de inmediato, sin pasar por una espera humana, aunque needsApproval=true.
      const { rows: messages } = await engine.admin.query<{ delivery_status: string; simulated: boolean }>(
        "select delivery_status, simulated from public.message where hotel_id = $1;",
        [hotelId],
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]!.simulated).toBe(true);

      // La autorizacion del ticket queda como siguiente paso del journey (2a corrida,
      // ver prueba "autoriza el gasto...").
      const ticketId = tickets[0]!.id;

      const { runner: runner2 } = buildRunner(gate, [
        { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost: 4300 } }] },
        { kind: "final", text: "Esperando autorización del gasto." },
      ]);
      const result2 = await runner2.run(ctx, "El técnico ya diagnosticó: la reparación cuesta $4,300 MXN.");
      expect(result2.status).toBe("esperando_aprobacion");
      expect(result2.pendingApprovalIds).toHaveLength(1);

      const { rows: ticketAfterRequest } = await engine.admin.query<{ status: string; actual_cost: string | null }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(ticketAfterRequest[0]!.status).not.toBe("cerrado");
      expect(ticketAfterRequest[0]!.actual_cost).toBeNull();
    });
  }

  it("doble confirmación por DOS actores/roles distintos ejecuta la autorización y cierra el ticket (fuera de la corrida del agente)", async () => {
    const { runner } = buildRunner("propone", [
      {
        kind: "tool_calls",
        calls: [
          {
            name: "crear_ticket_mantenimiento",
            input: { roomCode, title: "Fuga de agua", description: "Fuga visible bajo el lavabo.", severity: "alta", estimatedCost: 2000 },
          },
        ],
      },
      { kind: "final", text: "Ticket creado." },
    ]);
    const ctx = buildCtx("req-journey-1");
    await runner.run(ctx, "Reporto fuga de agua en el baño.");
    const { rows: tickets } = await engine.admin.query<{ id: string }>(
      "select id from public.maintenance_ticket where hotel_id = $1;",
      [hotelId],
    );
    const ticketId = tickets[0]!.id;

    const { runner: authRunner, approvalQueue } = buildRunner("propone", [
      { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost: 1800 } }] },
      { kind: "final", text: "Esperando aprobación." },
    ]);
    const firstResult = await authRunner.run(ctx, "El plomero cotizó $1,800 MXN.");
    expect(firstResult.status).toBe("esperando_aprobacion");
    const approvalId = firstResult.pendingApprovalIds[0]!;

    const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    const gm = seed.hotels[0]!.staff.find((s) => s.role === "gm")!;

    await approvalQueue.decide({ approvalId, actor: owner.id, role: "owner", decision: "aprobar", textoExacto: "Autorizo $1,800 MXN" });
    const decided = await approvalQueue.decide({ approvalId, actor: gm.id, role: "gm", decision: "aprobar", textoExacto: "Autorizo $1,800 MXN" });
    expect(decided.status).toBe("aprobada");

    // Reintenta la MISMA llamada (mismo tool+input): la ApprovalQueue reusa la solicitud
    // YA aprobada, asi que esta vez `tool.run()` SI se ejecuta.
    const { runner: retryRunner } = buildRunner("propone", [
      { kind: "tool_calls", calls: [{ name: "autorizar_gasto_mantenimiento", input: { ticketId, actualCost: 1800 } }] },
      { kind: "final", text: "Gasto autorizado y ticket cerrado." },
    ]);
    const finalResult = await retryRunner.run(ctx, "El plomero cotizó $1,800 MXN.");
    expect(finalResult.status).toBe("completado");

    const { rows: closedTicket } = await engine.admin.query<{ status: string; actual_cost: string }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(closedTicket[0]!.status).toBe("cerrado");
    expect(Number(closedTicket[0]!.actual_cost)).toBe(1800);
  });
});
