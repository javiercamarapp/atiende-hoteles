// A3/T3 (auditoria-2, agentico.md/tool-calling.md/backend.md): `PostgresApprovalQueue
// .decide()` no tenia ningun bloqueo de fila -- dos decisiones CASI SIMULTANEAS sobre
// la MISMA aprobacion podian ambas leer `status='pendiente'`/las mismas confirmaciones
// ANTES de que cualquiera escribiera, y ambas terminar disparando la ejecucion de la
// tool aprobada. Contra un `embedded-postgres` real y local, la ventana de la carrera
// es demasiado angosta para forzarla de forma determinista sin instrumentar el propio
// codigo de produccion (mismo problema que documento el auditor de tool-calling.md:
// "no logre ganar la ventana... latencia demasiado baja/uniforme").
//
// Esta prueba corre el codigo REAL de `PostgresApprovalQueue` (import sin mock) contra
// un `SqlClient` FAKE que solo emula el transporte SQL en memoria -- MISMO patron de
// verificacion que uso el auditor original -- pero con un bloqueo de fila real
// (simulado): una consulta con `for update` en el SQL espera a que la sesion que ya
// tiene el "lock" llame a `commit()`, exactamente como Postgres bloquea una segunda
// transaccion hasta que la primera hace COMMIT/ROLLBACK. Esto SI reproduce la carrera
// de forma 100% determinista, sin depender de la velocidad relativa de dos conexiones
// reales.
import { describe, expect, it } from "vitest";
import { PostgresApprovalQueue } from "../../../packages/agent-core/src/postgresApproval.ts";
import type { SqlClient, SqlQueryResult } from "../../../packages/agent-core/src/sql.ts";

interface FakeApprovalRow {
  id: string;
  org_id: string;
  hotel_id: string;
  tool_name: string;
  input_hash: string;
  input_summary: string;
  texto_mostrado: string;
  requested_by: string;
  is_money: boolean;
  required_confirmations: number;
  status: string;
  requested_at: string;
  expires_at: string;
}

interface FakeConfirmationRow {
  actor: string;
  role: string | null;
  decision: string;
  texto_exacto: string;
  decided_at: string;
}

interface FakeStore {
  row: FakeApprovalRow;
  confirmations: FakeConfirmationRow[];
  lockedBy: string | null;
  waiters: Array<() => void>;
}

function createStore(overrides: Partial<FakeApprovalRow> = {}): FakeStore {
  const now = new Date();
  const future = new Date(now.getTime() + 15 * 60_000);
  return {
    row: {
      id: "approval-1",
      org_id: "org-1",
      hotel_id: "hotel-1",
      tool_name: "autorizar_gasto_mantenimiento",
      input_hash: "hash-1",
      input_summary: "resumen",
      texto_mostrado: "autorizar 8000 MXN",
      requested_by: "agent:mantenimiento:1",
      is_money: true,
      required_confirmations: 2,
      status: "pendiente",
      requested_at: now.toISOString(),
      expires_at: future.toISOString(),
      ...overrides,
    },
    confirmations: [],
    lockedBy: null,
    waiters: [],
  };
}

/** "COMMIT" simulado: libera el lock de fila que esta sesion tuviera tomado y
 *  despierta al siguiente en espera (FIFO), igual que Postgres libera un
 *  `pg_advisory`/lock de fila al terminar la transaccion. */
function commit(store: FakeStore, session: string): void {
  if (store.lockedBy === session) {
    store.lockedBy = null;
    const next = store.waiters.shift();
    next?.();
  }
}

/** `SqlClient` fake: interpreta por patron el SQL real que emite
 *  `postgresApproval.ts` (sin reimplementar su logica) contra un `FakeStore`
 *  compartido entre "sesiones". Una consulta con `for update` en el texto simula el
 *  bloqueo de fila real de Postgres: si otra sesion ya tiene el lock, espera hasta que
 *  esa sesion llame a `commit()`. */
function makeFakeClient(store: FakeStore, session: string): SqlClient {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<SqlQueryResult<T>> {
      const s = sql.toLowerCase().replace(/\s+/g, " ").trim();

      if (s.includes("for update")) {
        while (store.lockedBy !== null && store.lockedBy !== session) {
          await new Promise<void>((resolve) => store.waiters.push(resolve));
        }
        store.lockedBy = session;
      }

      if (s.startsWith("select") && s.includes("from public.agent_approval ") && !s.includes("confirmation")) {
        return { rows: [{ ...store.row }] as T[] };
      }
      if (s.startsWith("select") && s.includes("agent_approval_confirmation")) {
        return { rows: store.confirmations.map((c) => ({ ...c })) as T[] };
      }
      if (s.startsWith("insert into public.agent_approval_confirmation")) {
        const [, actor, role, decision, textoExacto, decidedAt] = params as [string, string, string | null, string, string, string];
        store.confirmations.push({ actor, role, decision, texto_exacto: textoExacto, decided_at: decidedAt });
        return { rows: [] as T[] };
      }
      if (s.startsWith("update public.agent_approval set status")) {
        // La restriccion "and status = 'pendiente'" del fix (estado terminal unico) se
        // respeta tambien aqui: sin ella, una actualizacion "tardia" (tras el fix,
        // nunca ocurre por el lock; sin el fix, esta prueba fuerza el escenario)
        // sobreescribiria un estado ya resuelto por la otra sesion.
        const guardedByPendingCheck = s.includes("and status = 'pendiente'");
        if (guardedByPendingCheck && store.row.status !== "pendiente") {
          return { rows: [] as T[] }; // 0 filas afectadas, como el UPDATE real
        }
        if (s.includes("'aprobada'")) store.row.status = "aprobada";
        else if (s.includes("'rechazada'")) store.row.status = "rechazada";
        else if (s.includes("'expirada'")) store.row.status = "expirada";
        return { rows: [] as T[] };
      }
      throw new Error(`FakeSqlClient: consulta no reconocida: ${sql}`);
    },
  };
}

describe("PostgresApprovalQueue.decide() -- concurrencia (A3/T3, código real + SqlClient fake)", () => {
  it("SIN el lock de fila (simulando el código pre-fix, sin 'for update'): dos decide() concurrentes AMBOS aprueban -- efecto duplicado", async () => {
    const store = createStore();
    store.confirmations.push({ actor: "gm-1", role: "gm", decision: "aprobar", texto_exacto: "x", decided_at: new Date().toISOString() });

    // Fake SIN reconocer "for update" como bloqueante: emula el código ANTES del fix
    // (fetchRowOrThrow siempre hacía una lectura simple, nunca `SELECT ... FOR
    // UPDATE`) parcheando el SqlClient para que decide() reciba el mismo texto de
    // consulta real, pero interceptando el propio `PostgresApprovalQueue` construido
    // SIN la palabra clave no es posible sin tocar el archivo -- en vez de eso, se
    // verifica el escenario equivalente: dos sesiones que jamás toman el lock
    // (`makeFakeClientSinLock`) porque ninguna consulta que reciben incluye "for
    // update" en este armado (ver siguiente prueba para el código real CON el fix).
    const makeFakeClientSinLock = (session: string): SqlClient => {
      const real = makeFakeClient(store, session);
      return {
        async query<T>(sql: string, params: unknown[] = []) {
          // Quita "for update" del texto antes de pasarlo al fake -- simula
          // exactamente el SQL que emitía `fetchRowOrThrow` ANTES del fix.
          return real.query<T>(sql.replace(/\s+for update/i, ""), params);
        },
      };
    };

    const queueA = new PostgresApprovalQueue(makeFakeClientSinLock("A"));
    const queueB = new PostgresApprovalQueue(makeFakeClientSinLock("B"));

    // Ambas leen el mismo estado "pendiente/1 confirmación" antes de que cualquiera
    // escriba -- ninguna espera a la otra porque ninguna toma un lock de fila.
    const [resA, resB] = await Promise.all([
      queueA.decide({ approvalId: store.row.id, actor: "owner-1", role: "owner", decision: "aprobar", textoExacto: "x" }),
      queueB.decide({ approvalId: store.row.id, actor: "owner-2", role: "owner", decision: "aprobar", textoExacto: "x" }),
    ]);

    // El defecto original: AMBAS transiciones ven "aprobada" -- la tool se ejecutaría
    // dos veces (aprobacionEjecutor.ts corre `tool.run()` cada vez que ve "aprobada").
    expect(resA.status).toBe("aprobada");
    expect(resB.status).toBe("aprobada");
    expect(store.confirmations).toHaveLength(3); // gm-1 + owner-1 + owner-2 (duplicado)
  });

  it("CON el fix real (SELECT ... FOR UPDATE + estado terminal único): dos decide() concurrentes -- UNA aprueba, la otra falla explícito, nunca las dos", async () => {
    const store = createStore();
    store.confirmations.push({ actor: "gm-1", role: "gm", decision: "aprobar", texto_exacto: "x", decided_at: new Date().toISOString() });

    // Código REAL de PostgresApprovalQueue.decide() (sin mock), con el fake
    // reconociendo "for update" (el SQL real que ahora emite `fetchRowOrThrow`)
    // como bloqueo de fila real.
    const queueA = new PostgresApprovalQueue(makeFakeClient(store, "A"));
    const queueB = new PostgresApprovalQueue(makeFakeClient(store, "B"));

    const pA = queueA
      .decide({ approvalId: store.row.id, actor: "owner-1", role: "owner", decision: "aprobar", textoExacto: "x" })
      .finally(() => commit(store, "A")); // "COMMIT" de A justo cuando su decide() resuelve.
    const pB = queueB
      .decide({ approvalId: store.row.id, actor: "owner-2", role: "owner", decision: "aprobar", textoExacto: "x" })
      .finally(() => commit(store, "B"));

    const [resA, resB] = await Promise.allSettled([pA, pB]);
    const cumplidos = [resA, resB].filter((r) => r.status === "fulfilled");
    const rechazados = [resA, resB].filter((r) => r.status === "rejected");

    expect(cumplidos).toHaveLength(1);
    expect(rechazados).toHaveLength(1);
    expect((cumplidos[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("aprobada");
    expect((rechazados[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);

    // Estado final: exactamente 2 confirmaciones (gm-1 + UN owner), nunca 3.
    expect(store.confirmations).toHaveLength(2);
    expect(store.row.status).toBe("aprobada");
  });
});
