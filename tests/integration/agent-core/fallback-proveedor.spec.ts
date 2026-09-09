// REQ-AGT-011 (fuentes LLM-010/LLM-022/LLM-023/LLM-002/LLM-021/LLM-024/LLM-025/LLM-031):
// "el sistema debe mantener un fallback de proveedor de modelo en los canales
// conversacionales detrás de un router propio, para continuidad si el proveedor primario
// falla". Antes de este archivo, `provider.ts` no tenía ningún router -- el fallback
// documentado en `agent-core/README.md` §4 (`AgentRunner.fallbackProvider`) solo cubre un
// fallo TRANSITORIO a mitad de una llamada ya en curso, y ningún punto real de wiring
// (`apps/api/src/routes/agentes.ts`) lo pasaba nunca: el proveedor primario simplemente
// SIN credenciales (el caso más común en este entorno, ver `EnvProvider`) no tenía
// ninguna continuidad -- se cerraba `no_configurado` de inmediato.
//
// Este archivo verifica, contra un `embedded-postgres` REAL (ADR-003) con
// `PostgresApprovalQueue` real (no un mock), el wiring exacto que ahora usa
// `apps/api/src/routes/agentes.ts` para los canales conversacionales (`canal`/
// `enrutador`, roles.ts): `ProviderRouter` (provider.ts, nuevo) + `AgentRunner.
// fallbackProvider` (runner.ts, ya existía) combinados, cubriendo los DOS escenarios en
// que el proveedor primario puede fallar:
//   1. Nunca llega a intentar la llamada (sin credenciales) -- lo resuelve `ProviderRouter`.
//   2. Falla A MITAD de una llamada ya en curso (`ProviderTransientError`) -- lo resuelve
//      `AgentRunner.fallbackProvider`, reintentando la MISMA ronda sin repetir ninguna
//      tool ya ejecutada.
// Y el caso honesto: si NINGÚN proveedor está disponible, la corrida se cierra
// explícitamente `no_configurado`, nunca fabrica una respuesta.
//
// La otra mitad de este requisito ("cualquier cambio de proveedor de modelo/telefonía/BD
// requiere decisión reservada al fundador") ya está implementada y verificada con
// Postgres real en `tests/adversarial/decisiones-reservadas-fundador.spec.ts`
// (categoría `cambio_proveedor_modelo_telefonia_bd` del catálogo cerrado de REQ-GOB-012,
// migración `packages/db/migrations/0081_decisiones_reservadas_fundador.sql`) -- no se
// duplica aquí, solo se referencia como evidencia de esa cláusula.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunner,
  EnvProvider,
  FakeProvider,
  InMemoryCostLedger,
  PostgresApprovalQueue,
  ProviderRouter,
  ToolRegistry,
  buildToolContext,
  createHousekeepingTaskTool,
  createRunBudget,
  type AgentTraceEvent,
  type FakeStep,
  type LlmProvider,
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
  await engine.admin.exec(
    `truncate table public.agent_approval_confirmation, public.agent_approval, public.housekeeping_task
     restart identity cascade;`,
  );
});

/** Reproduce EXACTAMENTE el wiring conversacional de `apps/api/src/routes/agentes.ts`
 * (REQ-AGT-011): `ProviderRouter` como `provider` (continuidad si el primario nunca
 * estuvo disponible) + el MISMO proveedor de respaldo también como
 * `AgentRunner.fallbackProvider` (continuidad si el primario falla a mitad de una
 * llamada ya en curso). */
function buildConversationalRunner(opts: {
  readonly primario: LlmProvider;
  readonly respaldo: LlmProvider;
  readonly events: AgentTraceEvent[];
}) {
  const tools = new ToolRegistry();
  tools.register(createHousekeepingTaskTool({ db: engine.admin }));

  const approvalQueue = new PostgresApprovalQueue(engine.admin);

  return new AgentRunner({
    agentName: "recepcion_virtual",
    provider: new ProviderRouter({ providers: [opts.primario, opts.respaldo] }),
    fallbackProvider: opts.respaldo,
    tools,
    approvalQueue,
    systemPrompt: "Eres el agente de recepcion virtual de un hotel.",
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 6,
    pricing: {},
    gate: "propone",
    costLedger: new InMemoryCostLedger(),
    onTrace: (event) => opts.events.push(event),
  });
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

describe("REQ-AGT-011: fallback de proveedor de modelo en canales conversacionales (router propio + Postgres real)", () => {
  it("proveedor primario simulado como caído (sin credenciales) -> ProviderRouter continúa la conversación con el de respaldo, sin intentar la llamada perdida", async () => {
    const events: AgentTraceEvent[] = [];
    // "Caído" en el sentido más común de este entorno (ver EnvProvider): sin
    // credenciales configuradas, honestamente `isAvailable() === false`.
    const primarioCaido = new EnvProvider({ id: "anthropic-primario", env: {} });
    const respaldo = new FakeProvider([{ kind: "final", text: "Recepción confirmada por el proveedor de respaldo." }]);

    const runner = buildConversationalRunner({ primario: primarioCaido, respaldo, events });
    const result = await runner.run(buildCtx("req-fallback-1"), "Huésped pregunta el horario del check-out.");

    expect(result.status).toBe("completado");
    expect(result.finalText).toContain("proveedor de respaldo");
    // El router resolvió esto SIN que AgentRunner tuviera que reaccionar a ningún error
    // de proveedor -- no hay evento "provider_fallback" ni "error" en la traza porque,
    // desde el punto de vista de AgentRunner, la única llamada que hizo (al router)
    // simplemente tuvo éxito.
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.some((e) => e.kind === "provider_fallback")).toBe(false);
  });

  it("proveedor primario falla A MITAD de una llamada ya en curso (transitorio) -> AgentRunner.fallbackProvider reintenta la MISMA ronda, sin repetir ninguna tool ya ejecutada, y la traza deja rastro (provider_fallback)", async () => {
    const events: AgentTraceEvent[] = [];
    const script: FakeStep[] = [
      { kind: "tool_calls", calls: [{ name: "crear_tarea_housekeeping", input: { roomCode, priority: "media" } }] },
      { kind: "transient_error" }, // la SEGUNDA llamada al primario falla transitoriamente
    ];
    const primarioInestable = new FakeProvider(script);
    const respaldo = new FakeProvider([{ kind: "final", text: "Recuperado por el proveedor de respaldo tras el fallo transitorio." }]);

    const runner = buildConversationalRunner({ primario: primarioInestable, respaldo, events });
    const result = await runner.run(buildCtx("req-fallback-2"), "Huésped pide que limpien la habitación por la tarde.");

    expect(result.status).toBe("completado");
    expect(result.finalText).toContain("proveedor de respaldo");
    expect(events.some((e) => e.kind === "provider_fallback")).toBe(true);

    // La tool de housekeeping se ejecutó UNA sola vez -- el reintento del fallback repite
    // la LLAMADA al proveedor, nunca una tool ya ejecutada.
    const { rows } = await engine.admin.query<{ id: string }>(
      "select id from public.housekeeping_task where hotel_id = $1;",
      [hotelId],
    );
    expect(rows).toHaveLength(1);
  });

  it("si NINGÚN proveedor (ni primario ni respaldo) está disponible, la corrida se cierra explícitamente 'no_configurado' -- nunca fabrica una respuesta", async () => {
    const events: AgentTraceEvent[] = [];
    const primarioCaido = new EnvProvider({ id: "anthropic-primario", env: {} });
    const respaldoCaido = new EnvProvider({ id: "openrouter-respaldo", env: {} });

    const runner = buildConversationalRunner({ primario: primarioCaido, respaldo: respaldoCaido, events });
    const result = await runner.run(buildCtx("req-fallback-3"), "Huésped pregunta el horario del check-out.");

    expect(result.status).toBe("no_configurado");
    expect(result.finalText).toBeNull();
  });
});
