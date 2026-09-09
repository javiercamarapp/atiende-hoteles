// REQ-AGT-006 (GOB-035/BP-123/H08-020/BP-168) · "PII debe redactarse antes de persistir
// cualquier traza de observabilidad de agentes" (verificado con una traza sintética con
// PII → 0 PII en lo persistido).
//
// Enfoque: una corrida REAL de `AgentRunner` (agent-core) con `FakeProvider` cuyo
// mensaje de cierre representa el PEOR CASO honesto -- un modelo que, al confirmarle
// algo al huésped, cita de vuelta sus propios datos personales tal cual los trae en
// contexto (email, teléfono, CURP, RFC, tarjeta) -- exactamente el tipo de fuga que
// `redact()` (agent-core `redact.ts`) existe para atrapar. Los eventos de traza y el
// resultado de la corrida se persisten con el MISMO código que usa
// `apps/api/src/routes/agentes.ts` en producción (`persistAgentTraceEvents`/
// `persistAgentRunSummary`, `apps/api/src/lib/agentObservability.ts`), contra
// `embedded-postgres` real (ADR-003) -- nunca una reimplementación paralela del INSERT
// que pudiera divergir en silencio del código real.
//
// Gap real que este archivo cubre (ver comentario de archivo de agentObservability.ts):
// `AgentRunner.close()` (runner.ts) SÍ redacta el mensaje de cierre para el evento
// `run_finished` que va a `audit_log`, pero el `AgentRunResult.message` que RETORNA (la
// misma cadena, SIN redactar) es el valor que la ruta insertaba tal cual en
// `agent_run.message` -- sin este fix, la prueba de abajo que busca la PII sintética en
// `agent_run` habría encontrado la PII completa, sin redactar.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunner,
  FakeProvider,
  InMemoryApprovalQueue,
  ToolRegistry,
  buildToolContext,
  createRunBudget,
  type AgentTraceEvent,
} from "@atiende-hoteles/agent-core";
import {
  applyMigrations,
  openEmbeddedPostgres,
  seedDev,
  type EmbeddedPostgresEngine,
  type SeedResult,
} from "@atiende-hoteles/db";
import { persistAgentRunSummary, persistAgentTraceEvents } from "../../apps/api/src/lib/agentObservability.ts";

let engine: EmbeddedPostgresEngine;
let seed: SeedResult;
let hotelId: string;
let orgId: string;

beforeAll(async () => {
  engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  seed = await seedDev(engine.admin);
  hotelId = seed.hotels[0]!.id;
  orgId = seed.orgId;
});

afterAll(async () => {
  await engine.stop();
});

afterEach(async () => {
  await engine.admin.exec(`delete from public.agent_run where hotel_id = $1;`.replace("$1", `'${hotelId}'`));
});

/** Marcadores de PII ÚNICOS por corrida (sufijo `randomUUID()`) para que un "0
 *  coincidencias" no sea un falso negativo por un dato que ya estuviera en la BD sembrada
 *  por otra razón -- mismo criterio que `rfcValidoUnico()` de
 *  `consentimiento-biometrico.spec.ts`. Formas REALES que `redact()` reconoce
 *  (packages/agent-core/src/redact.ts): email, teléfono MX, CURP, RFC persona física,
 *  número de tarjeta. */
function piiSinteticaUnica(): {
  email: string;
  telefono: string;
  curp: string;
  rfc: string;
  tarjeta: string;
  marker: string;
} {
  const marker = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  // Último dígito del CURP derivado del marker con aritmética de ENTEROS simple
  // (parseInt hex de un solo caracter, nunca `Number(str, radix)` -- ese segundo
  // argumento de `Number()` se ignora en silencio, así que un caracter hex no numérico
  // como "A" producía `NaN` y rompía la forma exacta de 18 caracteres que CURP_RE exige,
  // dejando el CURP SIN redactar -- no por un fallo del redactor, sino por un dato de
  // prueba mal formado).
  const ultimoDigitoCurp = parseInt(marker.slice(0, 1), 16) % 10;
  return {
    email: `huesped.${marker.toLowerCase()}@correo-prueba.mx`,
    telefono: "+52 55 1234 5678",
    curp: `PEMJ900101HDFRRL0${ultimoDigitoCurp}`, // 18 chars, forma CURP válida
    rfc: "PEMJ9001019Z2", // RFC persona física con forma válida (13 chars)
    tarjeta: "4111 1111 1111 1111", // número de tarjeta con forma válida (Luhn de prueba estándar)
    marker,
  };
}

/** Arma y corre un `AgentRunner` de un solo paso ("final" inmediato, sin tools) cuyo
 *  mensaje de cierre incluye la PII sintética recibida -- simula el peor caso honesto de
 *  un modelo que confirma datos del huésped citándolos de vuelta tal cual. Devuelve tanto
 *  los `AgentTraceEvent` capturados por `onTrace` (lo que la ruta real inserta en
 *  `audit_log`) como el `AgentRunResult` (lo que la ruta real inserta en `agent_run`) --
 *  exactamente los dos insumos que `apps/api/src/routes/agentes.ts` reúne antes de
 *  persistir. */
async function correrConPiiEnMensajeDeCierre(pii: ReturnType<typeof piiSinteticaUnica>, requestId: string) {
  const closingText =
    `Listo, confirmamos tu reserva. Te escribimos a ${pii.email} y te llamamos al ${pii.telefono} ` +
    `si hace falta algo más. Registramos tu CURP ${pii.curp}, tu RFC ${pii.rfc} y la tarjeta ` +
    `${pii.tarjeta} para el cargo de garantía.`;

  const events: AgentTraceEvent[] = [];
  const runner = new AgentRunner({
    agentName: "recepcion_virtual",
    provider: new FakeProvider([{ kind: "final", text: closingText }]),
    tools: new ToolRegistry(),
    approvalQueue: new InMemoryApprovalQueue(),
    systemPrompt: "system prompt de prueba, sin PII.",
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 4,
    pricing: {},
    gate: "shadow",
    onTrace: (event) => events.push(event),
  });

  const ctx = buildToolContext(
    { orgId, hotelId, actor: { type: "staff", id: seed.hotels[0]!.staff[0]!.id }, requestId },
    createRunBudget({ maxUsd: 10, maxMs: 60_000, maxTokens: 200_000 }),
  );

  const result = await runner.run(ctx, "hola");
  return { events, result };
}

/** Busca cualquiera de los valores de PII como subcadena en TODAS las columnas de texto/
 *  jsonb de `audit_log` y `agent_run` que la persistencia real de agentes.ts toca --
 *  mismo patrón que `contarCoincidencias()` de `consentimiento-biometrico.spec.ts`.
 *  Devuelve el conteo total de filas donde apareció, por tabla. */
async function contarCoincidenciasPii(
  db: EmbeddedPostgresEngine["admin"],
  valor: string,
): Promise<Record<string, number>> {
  const consultas: Record<string, string> = {
    audit_log: `select count(*)::int as n from public.audit_log where payload::text ilike $1`,
    agent_run: `select count(*)::int as n from public.agent_run where coalesce(message, '') ilike $1`,
  };
  const resultado: Record<string, number> = {};
  for (const [tabla, sql] of Object.entries(consultas)) {
    const { rows } = await db.query<{ n: number }>(sql, [`%${valor}%`]);
    resultado[tabla] = rows[0]!.n;
  }
  return resultado;
}

function totalCoincidencias(mapa: Record<string, number>): number {
  return Object.values(mapa).reduce((a, b) => a + b, 0);
}

describe("REQ-AGT-006: PII redactada antes de persistir traza de observabilidad de agentes", () => {
  it("control: la traza sintética SÍ contiene la PII cruda antes de persistir (confirma que el escenario de prueba es real, no un caso ya inocuo)", async () => {
    const pii = piiSinteticaUnica();
    const { result } = await correrConPiiEnMensajeDeCierre(pii, `req-control-${pii.marker}`);

    expect(result.message).toContain(pii.email);
    expect(result.message).toContain(pii.curp);
    expect(result.message).toContain(pii.rfc);
    expect(result.message).toContain(pii.tarjeta.replace(/ /g, "").slice(0, 4)); // primeros dígitos crudos
  });

  it("tras persistir con el código real de producción (persistAgentTraceEvents/persistAgentRunSummary), 0 fila de audit_log/agent_run contiene el email/CURP/RFC/tarjeta sintéticos", async () => {
    const pii = piiSinteticaUnica();
    const requestId = `req-pii-${pii.marker}`;
    const { events, result } = await correrConPiiEnMensajeDeCierre(pii, requestId);

    // Mismo orden que la ruta real: eventos de traza -> audit_log, luego resumen -> agent_run.
    await persistAgentTraceEvents({ db: engine.admin, orgId, hotelId, agentName: "recepcion_virtual", events });
    await persistAgentRunSummary({
      db: engine.admin,
      runId: result.runId,
      orgId,
      hotelId,
      agentName: "recepcion_virtual",
      modelRole: "canal",
      providerId: "fake",
      modelSlug: "claude-sonnet-5",
      gate: "shadow",
      status: result.status,
      steps: result.steps,
      tokensIn: 50,
      tokensOut: 20,
      costUsd: 0,
      requestId,
      actorType: "staff",
      actorId: seed.hotels[0]!.staff[0]!.id,
      durationMs: 1,
      message: result.message,
    });

    for (const valor of [pii.email, pii.curp, pii.rfc, pii.tarjeta.replace(/ /g, "")]) {
      const coincidencias = await contarCoincidenciasPii(engine.admin, valor);
      expect(totalCoincidencias(coincidencias)).toBe(0);
    }
    // Teléfono: redact() SOLO enmascara si trae ≥10 dígitos corridos -- se busca la
    // forma exacta que trajo el mensaje de cierre.
    const coincidenciasTelefono = await contarCoincidenciasPii(engine.admin, pii.telefono);
    expect(totalCoincidencias(coincidenciasTelefono)).toBe(0);

    // Control positivo del propio mecanismo de búsqueda: el marcador de la corrida
    // (agentName/runId, que SÍ debe persistirse tal cual, sin redactar) aparece -- si
    // esto fallara, un "0" de arriba podría ser un falso negativo por una query rota.
    const { rows: agentRunRows } = await engine.admin.query<{ n: number }>(
      `select count(*)::int as n from public.agent_run where run_id = $1;`,
      [result.runId],
    );
    expect(agentRunRows[0]!.n).toBeGreaterThanOrEqual(1);
    const { rows: auditRows } = await engine.admin.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log where payload::text ilike $1;`,
      [`%${result.runId}%`],
    );
    expect(auditRows[0]!.n).toBeGreaterThanOrEqual(1);

    // Verificación directa de la columna `agent_run.message`: debe contener el
    // placeholder de redacción, no la PII cruda que sí trae `result.message`.
    const { rows: messageRows } = await engine.admin.query<{ message: string }>(
      `select message from public.agent_run where run_id = $1;`,
      [result.runId],
    );
    const mensajePersistido = messageRows[0]!.message;
    expect(mensajePersistido).not.toContain(pii.email);
    expect(mensajePersistido).not.toContain(pii.curp);
    expect(mensajePersistido).not.toContain(pii.rfc);
    expect(mensajePersistido).toContain("[EMAIL]");
    expect(mensajePersistido).toContain("[CURP]");
    expect(mensajePersistido).toContain("[RFC]");
    expect(mensajePersistido).toContain("[TARJETA]");
  });

  it("`persistAgentTraceEvents` redacta un `event.message` sin redactar (defensa en profundidad): un onTrace hipotético que olvide llamar redact() no filtra PII a audit_log", async () => {
    const pii = piiSinteticaUnica();
    const runId = randomUUID();
    // Evento fabricado a propósito CON PII cruda en `message` -- simula el caso en que
    // un futuro punto de emisión de agent-core olvidara pasar el texto por redact()
    // antes de emit(). persistAgentTraceEvents() debe seguir redactando en el punto de
    // persistencia, como última barrera.
    const eventoSinRedactar: AgentTraceEvent = {
      runId,
      orgId,
      hotelId,
      requestId: `req-sin-redactar-${pii.marker}`,
      step: 1,
      kind: "run_finished",
      at: new Date().toISOString(),
      message: `contacto: ${pii.email} / ${pii.rfc}`,
    };

    await persistAgentTraceEvents({
      db: engine.admin,
      orgId,
      hotelId,
      agentName: "recepcion_virtual",
      events: [eventoSinRedactar],
    });

    const coincidenciasEmail = await contarCoincidenciasPii(engine.admin, pii.email);
    const coincidenciasRfc = await contarCoincidenciasPii(engine.admin, pii.rfc);
    expect(totalCoincidencias(coincidenciasEmail)).toBe(0);
    expect(totalCoincidencias(coincidenciasRfc)).toBe(0);

    const { rows } = await engine.admin.query<{ payload: { mensaje: string } }>(
      `select payload from public.audit_log where payload::text ilike $1 order by created_at desc limit 1;`,
      [`%${runId}%`],
    );
    expect(rows[0]!.payload.mensaje).toContain("[EMAIL]");
    expect(rows[0]!.payload.mensaje).toContain("[RFC]");
  });
});
