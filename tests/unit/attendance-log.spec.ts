// REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): attendance_log es append-only y encadenado
// por hash POR EMPLEADO (packages/db/migrations/0118_attendance_log.sql, mismo patrón
// de "cabeza de cadena" + FOR UPDATE que audit_log/0015 -- ver tests/unit/audit-log.spec.ts
// para el precedente). staff_schedule (0090) es el horario programado contra el que se
// cruza -- mutable a propósito, protegido por su propia función SECURITY DEFINER.
// La inmutabilidad ejercida vía HTTP real (con sesión de staff auténtica, no admin) está
// en tests/adversarial/checador-inalterable.spec.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../support/pglite-fixture.ts";

interface AttendanceRow {
  id: string;
  hotel_id: string;
  staff_user_id: string;
  event_type: "entrada" | "salida";
  recorded_at: string;
  source: string;
  note: string | null;
  seq: string;
  prev_hash: string | null;
  hash: string;
}

const RECOMPUTE_HASH_SQL = `
  select
    hash,
    encode(
      sha256(convert_to(
        coalesce(prev_hash, '<genesis>')
          || '|' || hotel_id::text
          || '|' || staff_user_id::text
          || '|' || event_type::text
          || '|' || recorded_at::text
          || '|' || source
          || '|' || coalesce(note, ''),
        'UTF8'
      )),
      'hex'
    ) as recomputed
  from public.attendance_log
  where id = $1;
`;

describe("attendance_log: append-only + cadena de hash por empleado", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("registra entrada/salida vía record_attendance_event() dentro de una sesión real de staff", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    const { rows } = await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query<{ id: string; event_type: string; staff_user_id: string }>(
        "select (public.record_attendance_event($1, 'entrada')).*;",
        [hotelA.id],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("entrada");
    expect(rows[0]!.staff_user_id).toBe(frontdesk.id);
  });

  it("SIEMPRE registra al propio auth.uid(): no existe ningún parámetro para fichar a nombre de otro empleado", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;
    const housekeeping = hotelA.staff.find((s) => s.role === "housekeeping")!;

    // La firma de record_attendance_event() no acepta un staff_user_id -- se verifica
    // en tiempo de ejecución que, sin importar quién más pertenezca al hotel, la fila
    // insertada queda siempre a nombre de quien inició la sesión.
    await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );

    const { rows } = await fixture.engine.admin.query<{ staff_user_id: string }>(
      "select staff_user_id from public.attendance_log where hotel_id = $1;",
      [hotelA.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.staff_user_id).toBe(frontdesk.id);
    expect(rows[0]!.staff_user_id).not.toBe(housekeeping.id);
  });

  it("rechaza registrar asistencia en un hotel al que el empleado no pertenece", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const frontdeskA = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await expect(
      fixture.engine.withSession({ userId: frontdeskA.id }, (session) =>
        session.query("select public.record_attendance_event($1, 'entrada');", [hotelB.id]),
      ),
    ).rejects.toThrow(/hotel_no_autorizado/);
  });

  it("cada fila referencia el hash de la fila anterior DEL MISMO empleado, y la primera no tiene prev_hash", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    for (const eventType of ["entrada", "salida", "entrada"]) {
      await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
        session.query("select public.record_attendance_event($1, $2);", [hotelA.id, eventType]),
      );
    }

    const { rows } = await fixture.engine.admin.query<AttendanceRow>(
      "select * from public.attendance_log where staff_user_id = $1 order by seq asc;",
      [frontdesk.id],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBeNull();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
  });

  it("dos empleados distintos tienen cadenas de hash INDEPENDIENTES (una no referencia a la otra)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;
    const housekeeping = hotelA.staff.find((s) => s.role === "housekeeping")!;

    await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );
    await fixture.engine.withSession({ userId: housekeeping.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );

    const { rows: frontdeskRows } = await fixture.engine.admin.query<AttendanceRow>(
      "select * from public.attendance_log where staff_user_id = $1;",
      [frontdesk.id],
    );
    const { rows: housekeepingRows } = await fixture.engine.admin.query<AttendanceRow>(
      "select * from public.attendance_log where staff_user_id = $1;",
      [housekeeping.id],
    );

    expect(frontdeskRows[0]!.prev_hash).toBeNull();
    expect(housekeepingRows[0]!.prev_hash).toBeNull();
    expect(frontdeskRows[0]!.hash).not.toBe(housekeepingRows[0]!.hash);
  });

  it("el hash almacenado es verificable de forma independiente (recalculado desde las columnas persistidas coincide)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.attendance_log where staff_user_id = $1;",
      [frontdesk.id],
    );
    const { rows: verifyRows } = await fixture.engine.admin.query<{ hash: string; recomputed: string }>(
      RECOMPUTE_HASH_SQL,
      [rows[0]!.id],
    );
    expect(verifyRows[0]!.recomputed).toBe(verifyRows[0]!.hash);
  });

  it("rechaza UPDATE incluso ejecutado con el cliente admin/propietario de la migración", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.attendance_log where staff_user_id = $1;",
      [frontdesk.id],
    );

    await expect(
      fixture.engine.admin.query("update public.attendance_log set event_type = 'salida' where id = $1;", [
        rows[0]!.id,
      ]),
    ).rejects.toThrow(/attendance_log_append_only/);
  });

  it("rechaza DELETE incluso ejecutado con el cliente admin/propietario de la migración", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await fixture.engine.withSession({ userId: frontdesk.id }, (session) =>
      session.query("select public.record_attendance_event($1, 'entrada');", [hotelA.id]),
    );
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.attendance_log where staff_user_id = $1;",
      [frontdesk.id],
    );

    await expect(
      fixture.engine.admin.query("delete from public.attendance_log where id = $1;", [rows[0]!.id]),
    ).rejects.toThrow(/attendance_log_append_only/);
  });
});

describe("staff_schedule: horario programado (mutable, administrado por owner/gm)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("owner/gm puede programar un turno para un empleado de su propio hotel", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    const { rows } = await fixture.engine.withSession({ userId: gm.id }, (session) =>
      session.query<{ id: string; authorized_overtime_minutes: number }>(
        "select * from public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);",
        [hotelA.id, frontdesk.id, "2026-09-08", "2026-09-08T14:00:00Z", "2026-09-08T22:00:00Z", 30],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorized_overtime_minutes).toBe(30);
  });

  it("un rol sin administración (ej. housekeeping) NO puede programar horarios", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const housekeeping = hotelA.staff.find((s) => s.role === "housekeeping")!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await expect(
      fixture.engine.withSession({ userId: housekeeping.id }, (session) =>
        session.query("select public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);", [
          hotelA.id,
          frontdesk.id,
          "2026-09-08",
          "2026-09-08T14:00:00Z",
          "2026-09-08T22:00:00Z",
          0,
        ]),
      ),
    ).rejects.toThrow(/rol_no_autorizado/);
  });

  it("rechaza programar un horario para un empleado que no pertenece a ese hotel", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const frontdeskB = hotelB.staff.find((s) => s.role === "frontdesk")!;

    await expect(
      fixture.engine.withSession({ userId: gmA.id }, (session) =>
        session.query("select public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);", [
          hotelA.id,
          frontdeskB.id,
          "2026-09-08",
          "2026-09-08T14:00:00Z",
          "2026-09-08T22:00:00Z",
          0,
        ]),
      ),
    ).rejects.toThrow(/staff_no_pertenece_al_hotel/);
  });

  it("rechaza un rango con scheduled_end anterior o igual a scheduled_start", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await expect(
      fixture.engine.withSession({ userId: gm.id }, (session) =>
        session.query("select public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);", [
          hotelA.id,
          frontdesk.id,
          "2026-09-08",
          "2026-09-08T22:00:00Z",
          "2026-09-08T14:00:00Z",
          0,
        ]),
      ),
    ).rejects.toThrow(/rango_invalido/);
  });

  it("un segundo upsert para el mismo (hotel, empleado, fecha) reemplaza el turno en vez de duplicarlo", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;
    const frontdesk = hotelA.staff.find((s) => s.role === "frontdesk")!;

    await fixture.engine.withSession({ userId: gm.id }, (session) =>
      session.query("select public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);", [
        hotelA.id,
        frontdesk.id,
        "2026-09-08",
        "2026-09-08T14:00:00Z",
        "2026-09-08T22:00:00Z",
        0,
      ]),
    );
    await fixture.engine.withSession({ userId: gm.id }, (session) =>
      session.query("select public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);", [
        hotelA.id,
        frontdesk.id,
        "2026-09-08",
        "2026-09-08T15:00:00Z",
        "2026-09-08T23:00:00Z",
        45,
      ]),
    );

    const { rows } = await fixture.engine.admin.query<{ scheduled_start: string; authorized_overtime_minutes: number }>(
      "select scheduled_start, authorized_overtime_minutes from public.staff_schedule where hotel_id = $1 and staff_user_id = $2 and work_date = $3;",
      [hotelA.id, frontdesk.id, "2026-09-08"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorized_overtime_minutes).toBe(45);
  });
});
