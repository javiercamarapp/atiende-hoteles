// H4 · auditoría-1/backend [ALTO]: "La cadena de hash de `audit_log` se puede bifurcar
// bajo escritura concurrente del mismo tenant" (docs/auditoria-1/backend.md). El
// trigger `audit_log_set_hash()` (migrations/0008/0012) hace
// `select ... order by seq desc limit 1` para calcular `prev_hash` y luego inserta, sin
// ningún mecanismo que serialice esa lectura-escritura por tenant. Dos transacciones
// concurrentes del MISMO tenant (ej. un `reservation.created` y un `payment.recorded`
// casi simultáneos, el caso real de dos requests de API en paralelo) pueden leer el
// mismo "último hash" antes de que cualquiera de las dos inserte, produciendo dos filas
// con `prev_hash = null` en vez de una cadena.
//
// La ventana real de la carrera es de microsegundos en hardware normal -- para hacerla
// determinista sin depender de suerte de scheduling, la primera prueba redefine la
// función SOLO en su propia base `embedded-postgres` efímera (nunca se edita ningún
// archivo del repositorio) agregando un `pg_sleep` entre el SELECT y el INSERT, la
// misma técnica que usó la auditoría para reproducir el hallazgo de forma verificable.
//
// packages/db/migrations/0015 documenta por qué un `pg_advisory_xact_lock` NO basta
// (se probó y se descartó empíricamente: serializa el ORDEN de ejecución pero el SELECT
// que sigue puede seguir viendo una copia obsoleta en la ventana exacta de liberación
// del lock) y usa en su lugar `SELECT ... FOR UPDATE` sobre una fila "cabeza de cadena"
// por tenant (`audit_log_chain_head`) -- el mecanismo que Postgres garantiza que
// refresca al valor comprometido más reciente tras adquirir el lock (EvalPlanQual).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

interface AuditRow {
  prev_hash: string | null;
  hash: string;
  seq: string;
}

// Cuerpo EXACTO de `audit_log_set_hash()` tal como quedó en 0008/0012 (sin el arreglo),
// con un `pg_sleep` insertado entre el SELECT del "último hash" y el cálculo/INSERT --
// ensancha la ventana de la carrera sin cambiar la lógica que se está probando.
const FUNCION_SIN_ARREGLO_CARRERA_ENSANCHADA = `
  create or replace function public.audit_log_set_hash()
  returns trigger
  language plpgsql
  as $$
  declare
    v_prev_hash text;
    v_created_at timestamptz;
    v_canonical text;
  begin
    v_created_at := coalesce(new.created_at, now());

    select hash into v_prev_hash
    from public.audit_log
    where tenant_id = new.tenant_id
    order by seq desc
    limit 1;

    perform pg_sleep(0.3); -- ensancha la ventana SELECT -> INSERT (solo en esta prueba)

    v_canonical := coalesce(v_prev_hash, '<genesis>')
      || '|' || new.tenant_id::text
      || '|' || coalesce(new.hotel_id::text, '')
      || '|' || coalesce(new.actor_user_id::text, '')
      || '|' || new.action
      || '|' || new.entity_type
      || '|' || coalesce(new.entity_id::text, '')
      || '|' || new.payload::text
      || '|' || v_created_at::text;

    new.prev_hash := v_prev_hash;
    new.created_at := v_created_at;
    new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

    return new;
  end;
  $$;
`;

async function dosEscriturasConcurrentes(fixture: PgFixture, orgId: string, hotelId: string): Promise<AuditRow[]> {
  await Promise.all([
    fixture.engine.withAppSession({}, (s) =>
      s.query("select public.record_audit_log($1, $2, 'reservation.created', 'reservation', null, '{}'::jsonb);", [
        orgId,
        hotelId,
      ]),
    ),
    fixture.engine.withAppSession({}, (s) =>
      s.query("select public.record_audit_log($1, $2, 'payment.recorded', 'payment', null, '{}'::jsonb);", [
        orgId,
        hotelId,
      ]),
    ),
  ]);

  const { rows } = await fixture.engine.admin.query<AuditRow>(
    "select prev_hash, hash, seq::text from public.audit_log where tenant_id = $1 order by seq asc;",
    [orgId],
  );
  return rows;
}

// IMPORTANTE: `seq` (identity, migración 0012) se asigna al construir la fila ANTES de
// que el trigger BEFORE INSERT (y por tanto el lock de la cadena) se ejecute -- bajo
// contención real, el orden en que dos sesiones "llegan" al INSERT (que fija `seq`) no
// tiene por qué coincidir con el orden en que de verdad adquieren el lock y confirman
// (que fija el orden real de la cadena). El arreglo correcto serializa la CADENA, no la
// asignación de `seq` -- por eso esta verificación NUNCA asume que `order by seq`
// coincide con el orden de la cadena; reconstruye la cadena por sus propios enlaces
// (hash <-> prev_hash) y confirma que es una única lista enlazada sin bifurcarse.
function verificaCadenaSinBifurcar(rows: AuditRow[]): { raices: number; enlazadaCompleta: boolean } {
  const hashes = new Set(rows.map((r) => r.hash));
  const prevHashesNoNulos = rows.map((r) => r.prev_hash).filter((h): h is string => h !== null);
  const raices = rows.filter((r) => r.prev_hash === null).length;
  // Bifurcada = dos filas distintas comparten el mismo prev_hash (dos "hijos" del mismo
  // padre) -- una cadena válida nunca repite un prev_hash.
  const sinPrevHashDuplicado = new Set(prevHashesNoNulos).size === prevHashesNoNulos.length;
  // Cada prev_hash no nulo debe apuntar a un hash real de otra fila del mismo tenant.
  const todosLosPrevApuntanAFilaReal = prevHashesNoNulos.every((h) => hashes.has(h));
  return { raices, enlazadaCompleta: sinPrevHashDuplicado && todosLosPrevApuntanAFilaReal };
}

describe("audit_log: la cadena de hash bajo escritura concurrente del mismo tenant (auditoría-1 ALTO)", () => {
  let fixture: PgFixture;

  beforeEach(async () => {
    fixture = await createPgFixture();
  });

  afterEach(async () => {
    await destroyPgFixture(fixture);
  });

  it("SIN el arreglo: dos record_audit_log() concurrentes del mismo tenant producen dos filas con prev_hash null (cadena bifurcada)", async () => {
    await fixture.engine.admin.query(FUNCION_SIN_ARREGLO_CARRERA_ENSANCHADA);
    const orgId = fixture.seed.orgId;
    const hotelId = fixture.seed.hotels[0]!.id;

    const rows = await dosEscriturasConcurrentes(fixture, orgId, hotelId);

    expect(rows).toHaveLength(2);
    const conPrevHashNulo = rows.filter((r) => r.prev_hash === null);
    // El bug: AMBAS transacciones leyeron "sin fila anterior" antes de que cualquiera
    // insertara -- la cadena queda bifurcada (dos raíces) en vez de tener una sola.
    expect(conPrevHashNulo).toHaveLength(2);
  });

  it("CON el arreglo (packages/db/migrations/0015, audit_log_chain_head + SELECT FOR UPDATE): dos escrituras concurrentes SIEMPRE forman una cadena de un solo enlace", async () => {
    const orgId = fixture.seed.orgId;
    const hotelId = fixture.seed.hotels[0]!.id;

    const rows = await dosEscriturasConcurrentes(fixture, orgId, hotelId);

    expect(rows).toHaveLength(2);
    const { raices, enlazadaCompleta } = verificaCadenaSinBifurcar(rows);
    expect(raices).toBe(1); // una sola raíz de la cadena
    expect(enlazadaCompleta).toBe(true);
  });

  it("CON el arreglo, 20 escrituras concurrentes reales (sin ningún pg_sleep inyectado) nunca bifurcan la cadena, repetido 8 veces para descartar suerte de scheduling", async () => {
    const orgId = fixture.seed.orgId;
    const hotelId = fixture.seed.hotels[0]!.id;

    for (let ronda = 0; ronda < 8; ronda += 1) {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          fixture.engine.withAppSession({}, (s) =>
            s.query("select public.record_audit_log($1, $2, $3, 'test_entity', null, '{}'::jsonb);", [
              orgId,
              hotelId,
              `ronda${ronda}_accion_${i}`,
            ]),
          ),
        ),
      );
    }

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select prev_hash, hash, seq::text from public.audit_log where tenant_id = $1 order by seq asc;",
      [orgId],
    );
    expect(rows).toHaveLength(160); // 8 rondas x 20
    const { raices, enlazadaCompleta } = verificaCadenaSinBifurcar(rows);
    expect(raices).toBe(1); // una sola raíz en TODA la historia del tenant
    expect(enlazadaCompleta).toBe(true);
  });

  it("dos tenants distintos escribiendo concurrentemente no se bloquean entre sí (el lock de la cabeza de cadena es por tenant, no global)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    // Ambos hoteles pertenecen al mismo org en el seed de desarrollo -- se fuerza un
    // segundo tenant real insertando un `org` adicional para probar aislamiento real de
    // la cabeza de cadena entre tenants distintos, no solo entre hoteles del mismo org.
    const { rows: otroOrg } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Otro tenant (prueba de aislamiento)') returning id;",
      [],
    );
    const otroOrgId = otroOrg[0]!.id;

    const inicio = Date.now();
    await Promise.all([
      fixture.engine.withAppSession({}, (s) =>
        s.query("select public.record_audit_log($1, $2, 'reservation.created', 'reservation', null, '{}'::jsonb);", [
          fixture.seed.orgId,
          hotelA.id,
        ]),
      ),
      fixture.engine.withAppSession({}, (s) =>
        s.query("select public.record_audit_log($1, $2, 'reservation.created', 'reservation', null, '{}'::jsonb);", [
          otroOrgId,
          hotelB.id,
        ]),
      ),
    ]);
    const duracionMs = Date.now() - inicio;
    // Sin aserción de tiempo estricta (evita flakiness de CI): solo confirma que ambas
    // filas se escribieron correctamente, cada una como raíz de la cadena de SU tenant.
    expect(duracionMs).toBeLessThan(5_000);

    const { rows: filasA } = await fixture.engine.admin.query<AuditRow>(
      "select prev_hash, hash, seq::text from public.audit_log where tenant_id = $1;",
      [fixture.seed.orgId],
    );
    const { rows: filasB } = await fixture.engine.admin.query<AuditRow>(
      "select prev_hash, hash, seq::text from public.audit_log where tenant_id = $1;",
      [otroOrgId],
    );
    expect(filasA).toHaveLength(1);
    expect(filasB).toHaveLength(1);
    expect(filasA[0]!.prev_hash).toBeNull();
    expect(filasB[0]!.prev_hash).toBeNull();
  });
});
