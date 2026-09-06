// H4 · auditoría-1/backend [ALTO]: "La cadena de hash de `audit_log` se puede bifurcar
// bajo escritura concurrente del mismo tenant" (docs/auditoria-1/backend.md). El
// trigger `audit_log_set_hash()` (migrations/0008/0012) hace
// `select ... order by seq desc limit 1` para calcular `prev_hash` y luego inserta, sin
// ningún `pg_advisory_xact_lock` que serialice esa lectura-escritura por tenant. Dos
// transacciones concurrentes del MISMO tenant (ej. un `reservation.created` y un
// `payment.recorded` casi simultáneos, el caso real de dos requests de API en paralelo)
// pueden leer el mismo "último hash" antes de que cualquiera de las dos inserte,
// produciendo dos filas con `prev_hash = null` en vez de una cadena.
//
// La ventana real de la carrera (un SELECT+INSERT dentro de un mismo trigger) es de
// microsegundos en hardware normal -- para hacerla determinista sin depender de suerte
// de scheduling, esta prueba redefine la función SOLO en su propia base
// `embedded-postgres` efímera (nunca se edita ningún archivo del repositorio) agregando
// un `pg_sleep` entre el SELECT y el INSERT, exactamente la técnica que usó la
// auditoría para reproducir el hallazgo de forma verificable.
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

// Misma función, con el arreglo real (packages/db/migrations/0015_audit_log_lock.sql):
// un `pg_advisory_xact_lock` por tenant ANTES del SELECT, para que dos transacciones
// concurrentes del mismo tenant se serialicen. El `pg_sleep` se mantiene para probar que
// el arreglo sostiene la cadena incluso bajo una ventana de carrera artificialmente
// amplia, no solo bajo la (angosta) ventana real.
const FUNCION_CON_ARREGLO_CARRERA_ENSANCHADA = `
  create or replace function public.audit_log_set_hash()
  returns trigger
  language plpgsql
  as $$
  declare
    v_prev_hash text;
    v_created_at timestamptz;
    v_canonical text;
  begin
    perform pg_advisory_xact_lock(hashtext('audit_log:' || new.tenant_id::text));

    v_created_at := coalesce(new.created_at, now());

    select hash into v_prev_hash
    from public.audit_log
    where tenant_id = new.tenant_id
    order by seq desc
    limit 1;

    perform pg_sleep(0.3);

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

  it("CON el arreglo (packages/db/migrations/0015, advisory lock por tenant): la segunda escritura siempre encadena con la primera, incluso bajo la misma ventana de carrera ensanchada", async () => {
    await fixture.engine.admin.query(FUNCION_CON_ARREGLO_CARRERA_ENSANCHADA);
    const orgId = fixture.seed.orgId;
    const hotelId = fixture.seed.hotels[0]!.id;

    const rows = await dosEscriturasConcurrentes(fixture, orgId, hotelId);

    expect(rows).toHaveLength(2);
    const conPrevHashNulo = rows.filter((r) => r.prev_hash === null);
    expect(conPrevHashNulo).toHaveLength(1); // una sola raíz de la cadena
    const [primera, segunda] = rows;
    expect(segunda!.prev_hash).toBe(primera!.hash);
  });

  it("la migración 0015 ya aplicada (sin redefinir nada) reproduce la ventana angosta real sin romper la cadena en 20 escrituras concurrentes", async () => {
    // Sin ningún pg_sleep inyectado: ejercita la función TAL COMO quedó aplicada por
    // `applyMigrations` (packages/db/migrations/0015), bajo la ventana de carrera real
    // (angosta) -- confirma que el arreglo de producción, no solo la copia de la
    // prueba, sostiene la cadena.
    const orgId = fixture.seed.orgId;
    const hotelId = fixture.seed.hotels[0]!.id;

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fixture.engine.withAppSession({}, (s) =>
          s.query("select public.record_audit_log($1, $2, $3, 'test_entity', null, '{}'::jsonb);", [
            orgId,
            hotelId,
            `accion_concurrente_${i}`,
          ]),
        ),
      ),
    );

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select prev_hash, hash, seq::text from public.audit_log where tenant_id = $1 order by seq asc;",
      [orgId],
    );
    expect(rows).toHaveLength(20);
    expect(rows[0]!.prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }
  });
});
