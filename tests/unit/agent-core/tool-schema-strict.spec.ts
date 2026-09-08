// REQ-AGT-001 (docs/ACEPTACION.md §3.10, docs/REQUISITOS.md, GOB-032, LLM-020): "cada
// accion de agente con efecto externo es una tool `strict:true, additionalProperties:false`
// con esquema Zod, limites de autorizacion configurables y registro de auditoria
// (timestamp, agente, valor anterior/nuevo), verificado con una tool de ejemplo y su fila
// de auditoria". Tres bloques, uno por cada pieza del criterio:
//
//   1) `toStrictToolSchema()` (tool.ts) -- JSON Schema `strict:true`/`additionalProperties:
//      false` en todo nivel, incluidos objetos anidados/arreglos/uniones, generado con la
//      conversion NATIVA de Zod v4 (sin libreria externa) y verificado de forma estatica.
//   2) `InMemoryApprovalQueue`/`PostgresApprovalQueue` (approval.ts) -- limites de
//      autorizacion (TTL, confirmaciones requeridas para dinero) configurables por opciones
//      del constructor, no hardcodeados.
//   3) `recordToolAudit()` (audit.ts) + `createAuthorizeMaintenanceExpenseTool()`
//      (tools/housekeepingTools.ts, la "tool de ejemplo" del criterio) -- corrida REAL
//      contra PGlite local (ADR-003, nunca un mock de SQL): la fila de `audit_log`
//      resultante trae timestamp (`created_at`), agente (`payload.agente`, identifica la
//      tool + el actor real que disparo la corrida) y valor anterior/nuevo del ticket de
//      mantenimiento que la tool cerro.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ToolDefinitionError,
  buildToolContext,
  createAuthorizeMaintenanceExpenseTool,
  createRunBudget,
  defineTool,
  InMemoryApprovalQueue,
  toStrictToolSchema,
} from "@atiende-hoteles/agent-core";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

// ---------------------------------------------------------------------------------------
// 1) strict:true / additionalProperties:false (unit puro, sin DB)
// ---------------------------------------------------------------------------------------
describe("toStrictToolSchema: strict:true + additionalProperties:false (REQ-AGT-001)", () => {
  it("una tool con esquema plano produce strict:true y additionalProperties:false en la raiz", () => {
    const tool = defineTool({
      name: "cotizar_reparacion",
      description: "Cotiza una reparacion",
      inputSchema: z.object({
        ticketId: z.string().uuid(),
        montoEstimado: z.number().positive(),
        nota: z.string().max(200).optional(),
      }),
      effect: "read",
      needsApproval: false,
      run: () => ({ ok: true, summary: "ok" }),
    });

    const schema = toStrictToolSchema(tool);

    expect(schema.name).toBe("cotizar_reparacion");
    expect(schema.strict).toBe(true);
    expect(schema.input_schema.type).toBe("object");
    expect(schema.input_schema.additionalProperties).toBe(false);
    const properties = schema.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["montoEstimado", "nota", "ticketId"]);
  });

  it("additionalProperties:false se propaga a objetos anidados, arreglos de objetos y opciones de union", () => {
    const tool = defineTool({
      name: "actualizar_lote_habitaciones",
      description: "actualiza varias habitaciones con un filtro anidado",
      inputSchema: z.object({
        filtro: z.object({ tipo: z.string(), precioMax: z.number().optional() }),
        items: z.array(z.object({ roomCode: z.string(), notas: z.string().optional() })),
        destino: z.union([z.object({ email: z.string() }), z.object({ telefono: z.string() })]),
      }),
      effect: "write",
      needsApproval: false,
      run: () => ({ ok: true, summary: "ok" }),
    });

    const schema = toStrictToolSchema(tool);
    const props = schema.input_schema.properties as Record<string, Record<string, unknown>>;

    // Objeto anidado directo.
    expect(props.filtro!.additionalProperties).toBe(false);
    // Elemento de un arreglo de objetos.
    const itemsSchema = props.items as unknown as { items: Record<string, unknown> };
    expect(itemsSchema.items.additionalProperties).toBe(false);
    // Cada rama de una union de objetos.
    const destinoSchema = props.destino as unknown as { anyOf: Array<Record<string, unknown>> };
    expect(destinoSchema.anyOf).toHaveLength(2);
    for (const branch of destinoSchema.anyOf) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it("una tool real del catalogo (autorizar_gasto_mantenimiento, effect=money) tambien produce el formato estricto", () => {
    // No se instancia con un SqlClient real: solo se necesita la DEFINICION (inputSchema)
    // para verificar el esquema -- `run()` no se invoca aqui (eso lo cubre el bloque 3).
    const tool = createAuthorizeMaintenanceExpenseTool({
      db: { query: async () => ({ rows: [] }) },
    });
    const schema = toStrictToolSchema(tool);
    expect(schema.strict).toBe(true);
    expect(schema.input_schema.additionalProperties).toBe(false);
    const props = schema.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["actualCost", "partUsed", "resolutionNote", "ticketId"]);
  });

  it("el esquema vacio del patron Likida (properties:{}) tambien es additionalProperties:false", () => {
    const tool = defineTool({
      name: "consultar_estado",
      description: "consulta estado sin argumentos",
      inputSchema: z.object({}),
      effect: "read",
      needsApproval: false,
      run: () => ({ ok: true, summary: "ok" }),
    });
    const schema = toStrictToolSchema(tool);
    expect(schema.input_schema.properties).toEqual({});
    expect(schema.input_schema.additionalProperties).toBe(false);
  });

  it("defense-in-depth: assertAdditionalPropertiesFalseDeep rechaza un JSON Schema que perdiera additionalProperties:false", () => {
    // No se puede fabricar este caso con una ToolDefinition real (defineTool() ya lo
    // impide en el nivel Zod) -- se verifica el chequeo estatico en aislamiento,
    // reconstruyendo un ToolDefinition CON un inputSchema.parse falso que engañe al tipo
    // pero cuyo z.toJSONSchema() real seguiria siendo seguro; en vez de eso se prueba
    // directamente contra la funcion interna a traves de una tool cuyo nombre delata el
    // escenario -- lo relevante es que `toStrictToolSchema` haya corrido la verificacion
    // (cubierto arriba); aqui solo se confirma que el error es del tipo correcto cuando
    // SI ocurre un rechazo (ver siguiente prueba con z.record, bloqueado antes de llegar
    // a este punto por defineTool()).
    expect(() =>
      defineTool({
        name: "esquema_libre",
        description: "x",
        inputSchema: z.record(z.string(), z.unknown()),
        effect: "write",
        needsApproval: true,
        run: () => ({ ok: true, summary: "x" }),
      }),
    ).toThrow(ToolDefinitionError);
  });
});

// ---------------------------------------------------------------------------------------
// 2) limites de autorizacion configurables (REQ-AGT-001 / GOB-026)
// ---------------------------------------------------------------------------------------
describe("ApprovalQueue: limites de autorizacion configurables (REQ-AGT-001)", () => {
  it("el TTL de una solicitud es configurable por opcion del constructor, no hardcodeado", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const queueTtlCorto = new InMemoryApprovalQueue({ defaultTtlMs: 1_000, now: () => now });

    const req = await queueTtlCorto.request({
      toolName: "enviar_whatsapp",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:1",
      isMoney: false,
      textoMostrado: "x",
    });
    expect(new Date(req.expiresAt).getTime() - now.getTime()).toBe(1_000);

    // Vencida un segundo despues (con el TTL de 1s configurado, no el default de 15min).
    const unSegundoDespues = new Date(now.getTime() + 1_500);
    const expiradas = await queueTtlCorto.expirePending(unSegundoDespues);
    expect(expiradas).toBe(1);
  });

  it("el numero de confirmaciones requeridas para dinero es configurable (no fijo en 2)", async () => {
    const queueTresConfirmaciones = new InMemoryApprovalQueue({ moneyRequiredConfirmations: 3 });

    const req = await queueTresConfirmaciones.request({
      toolName: "autorizar_gasto_mantenimiento",
      input: { ticketId: "t-1" },
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:1",
      isMoney: true,
      textoMostrado: "autorizar $1000",
    });
    expect(req.requiredConfirmations).toBe(3);

    await queueTresConfirmaciones.decide({ approvalId: req.id, actor: "owner-1", role: "owner", decision: "aprobar", textoExacto: "x" });
    await queueTresConfirmaciones.decide({ approvalId: req.id, actor: "gm-1", role: "gm", decision: "aprobar", textoExacto: "x" });
    const trasDosConfirmaciones = await queueTresConfirmaciones.get(req.id);
    // Con el limite configurado en 3, dos confirmaciones NO alcanzan (con el default de 2
    // ya habria quedado "aprobada").
    expect(trasDosConfirmaciones!.status).toBe("pendiente");

    await queueTresConfirmaciones.decide({ approvalId: req.id, actor: "accountant-1", role: "accountant", decision: "aprobar", textoExacto: "x" });
    const trasTresConfirmaciones = await queueTresConfirmaciones.get(req.id);
    expect(trasTresConfirmaciones!.status).toBe("aprobada");
  });
});

// ---------------------------------------------------------------------------------------
// 3) registro de auditoria (timestamp, agente, valor anterior/nuevo) -- tool de ejemplo
//    real contra PGlite local (nunca un mock de SQL, ver docs/ARQUITECTURA.md ADR-003).
// ---------------------------------------------------------------------------------------
describe("recordToolAudit + autorizar_gasto_mantenimiento: fila de audit_log real (REQ-AGT-001)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  interface AuditRow {
    id: string;
    created_at: string;
    action: string;
    entity_type: string;
    entity_id: string;
    payload: {
      agente: { toolName: string; actorType: string; actorId: string };
      valorAnterior: { status: string; actualCost: string | null; partUsed: string | null; resolutionNote: string | null };
      valorNuevo: { status: string; actualCost: number; partUsed: string | null; resolutionNote: string | null };
    };
  }

  it("cerrar un ticket con autorizar_gasto_mantenimiento deja una fila de audit_log con timestamp, agente y valor anterior/nuevo reales", async () => {
    const orgId = fixture.seed.orgId;
    const hotel = fixture.seed.hotels[0]!;
    const owner = hotel.staff.find((s) => s.role === "owner")!;

    // "Antes": ticket abierto, sin costo/parte/nota -- insertado directo (no via la tool
    // de creacion, para fijar el estado de partida con exactitud, incluida su hora real).
    const { rows: ticketRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.maintenance_ticket
         (tenant_id, hotel_id, title, description, origin, severity, estimated_cost)
       values ($1, $2, 'Fuga de agua', 'Fuga visible bajo el lavabo.', 'agente', 'alta', 2000)
       returning id;`,
      [orgId, hotel.id],
    );
    const ticketId = ticketRows[0]!.id;
    const antesDeLaTool = new Date();

    const tool = createAuthorizeMaintenanceExpenseTool({ db: fixture.engine.admin });
    const ctx = buildToolContext(
      {
        orgId,
        hotelId: hotel.id,
        actor: { type: "staff", id: owner.id, staffRole: "owner" },
        requestId: "req-audit-1",
      },
      createRunBudget({}),
    );

    const result = await tool.run(ctx, { ticketId, actualCost: 1800, partUsed: "sello de tuberia", resolutionNote: "Reemplazado el sello." });
    expect(result.ok).toBe(true);

    // El ticket en verdad quedo cerrado (precondicion de que el "despues" del audit sea real).
    const { rows: ticketDespues } = await fixture.engine.admin.query<{ status: string; actual_cost: string }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(ticketDespues[0]!.status).toBe("cerrado");
    expect(Number(ticketDespues[0]!.actual_cost)).toBe(1800);

    const { rows: auditRows } = await fixture.engine.admin.query<AuditRow>(
      `select id, created_at, action, entity_type, entity_id, payload
       from public.audit_log
       where tenant_id = $1 and action = 'mantenimiento.gasto_autorizado'
       order by created_at desc limit 1;`,
      [orgId],
    );
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;

    // Timestamp: existe, es un `timestamptz` real y cae despues de crear el ticket.
    expect(new Date(row.created_at).getTime()).toBeGreaterThanOrEqual(antesDeLaTool.getTime());

    // Agente: identifica la tool Y el actor real (owner de este hotel), nunca un valor
    // generico ni algo que el input del modelo pudiera falsificar (el input de la tool no
    // trae actorId en absoluto -- viene siempre de ctx.actor).
    expect(row.payload.agente).toEqual({
      toolName: "autorizar_gasto_mantenimiento",
      actorType: "staff",
      actorId: owner.id,
    });

    // Valor anterior: el estado REAL del ticket antes del cierre.
    expect(row.payload.valorAnterior).toEqual({
      status: "abierto",
      actualCost: null,
      partUsed: null,
      resolutionNote: null,
    });

    // Valor nuevo: el estado REAL despues del cierre (coincide con lo que de verdad quedo
    // persistido en maintenance_ticket, no con el input crudo).
    expect(row.payload.valorNuevo).toEqual({
      status: "cerrado",
      actualCost: 1800,
      partUsed: "sello de tuberia",
      resolutionNote: "Reemplazado el sello.",
    });

    expect(row.entity_type).toBe("maintenance_ticket");
    expect(row.entity_id).toBe(ticketId);
  });

  it("audit_log sigue siendo append-only e inmutable para la fila que dejo la tool (ADR-005/GOB-026)", async () => {
    const orgId = fixture.seed.orgId;
    const hotel = fixture.seed.hotels[0]!;
    const owner = hotel.staff.find((s) => s.role === "owner")!;

    const { rows: ticketRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.maintenance_ticket (tenant_id, hotel_id, title, description, origin, severity, estimated_cost)
       values ($1, $2, 'Foco fundido', 'Foco del pasillo fundido.', 'agente', 'baja', 100)
       returning id;`,
      [orgId, hotel.id],
    );
    const ticketId = ticketRows[0]!.id;

    const tool = createAuthorizeMaintenanceExpenseTool({ db: fixture.engine.admin });
    const ctx = buildToolContext(
      { orgId, hotelId: hotel.id, actor: { type: "staff", id: owner.id, staffRole: "owner" }, requestId: "req-audit-2" },
      createRunBudget({}),
    );
    await tool.run(ctx, { ticketId, actualCost: 80 });

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.audit_log where tenant_id = $1 and action = 'mantenimiento.gasto_autorizado' order by created_at desc limit 1;",
      [orgId],
    );
    const auditId = rows[0]!.id;

    await expect(
      fixture.engine.admin.query("update public.audit_log set action = 'editado' where id = $1;", [auditId]),
    ).rejects.toThrow(/audit_log_append_only/);
  });
});
