// auditoria-1/bd (frente base de datos/seguridad multi-tenant): reproduce y cierra los
// hallazgos CRÍTICOS de docs/auditoria-1/seguridad.md y docs/auditoria-1/datos.md contra
// una sesión RLS real (embedded-postgres, nunca el cliente admin) — el mismo mecanismo
// que usó la propia auditoría para demostrar cada escenario.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, type ApiFixture } from "../support/api-fixture.ts";

describe("auditoria-1/bd: hallazgos CRÍTICOS de seguridad.md y datos.md", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  describe("[S-C1] record_audit_log() ya NO permite falsificar el audit_log de otra organización", () => {
    it("una sesión real de housekeeping no puede insertar una fila de audit_log para un org/hotel ajeno", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const housekeeping = hotelA.staff.find((s) => s.role === "housekeeping")!;

      const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.org (name) values ('Org Rival Ajena') returning id;",
      );
      const rivalOrgId = orgRows[0]!.id;
      const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Rival') returning id;",
        [rivalOrgId],
      );
      const rivalHotelId = locRows[0]!.id;
      await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [
        rivalHotelId,
        rivalOrgId,
      ]);

      await expect(
        fixture.engine.withAppSession({ userId: housekeeping.id }, (session) =>
          session.query(
            "select public.record_audit_log($1, $2, 'payment.recorded', 'payment', gen_random_uuid(), $3);",
            [rivalOrgId, rivalHotelId, JSON.stringify({ monto: 999999 })],
          ),
        ),
      ).rejects.toThrow(/tenant_no_autorizado/);

      const { rows: leaked } = await fixture.engine.admin.query(
        "select 1 from public.audit_log where tenant_id = $1;",
        [rivalOrgId],
      );
      expect(leaked).toHaveLength(0);
    });

    it("una sesión real SÍ puede seguir escribiendo audit_log de su propio org/hotel (no rompe el uso legítimo)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gm = hotelA.staff.find((s) => s.role === "gm")!;

      const { rows } = await fixture.engine.withAppSession({ userId: gm.id }, (session) =>
        session.query<{ id: string }>(
          "select (public.record_audit_log($1, $2, 'reservation.created', 'reservation', null, '{}'::jsonb)).id as id;",
          [fixture.seed.orgId, hotelA.id],
        ),
      );
      expect(rows[0]!.id).toBeTruthy();
    });

    it("un owner de Hotel Demo Centro NO puede firmar un audit_log a nombre de Hotel Demo Playa (mismo org, otro hotel)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const ownerA = hotelA.staff.find((s) => s.role === "owner")!;

      await expect(
        fixture.engine.withAppSession({ userId: ownerA.id }, (session) =>
          session.query(
            "select public.record_audit_log($1, $2, 'payment.recorded', 'payment', null, '{}'::jsonb);",
            [fixture.seed.orgId, hotelB.id],
          ),
        ),
      ).rejects.toThrow(/hotel_no_autorizado/);
    });
  });

  describe("[S-C2] outbox / idempotency_key ya NO se leen ni escriben entre hoteles de la misma org, ni por roles sin acceso a dinero", () => {
    it("housekeeping del Hotel Demo Centro no lee outbox/idempotency_key del Hotel Demo Playa", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const housekeepingA = hotelA.staff.find((s) => s.role === "housekeeping")!;

      await fixture.engine.admin.query(
        `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
         values ($1, $2, 'payment', gen_random_uuid(), 'payment.recorded', $3);`,
        [fixture.seed.orgId, hotelB.id, JSON.stringify({ monto: 7000, metodo: "tarjeta" })],
      );
      await fixture.engine.admin.query(
        `insert into public.idempotency_key (tenant_id, scope, key, response) values ($1, 'payment.create', 'clave-playa-1', $2);`,
        [fixture.seed.orgId, JSON.stringify({ monto: 7000 })],
      );

      const { rows: outboxRows } = await fixture.engine.withAppSession({ userId: housekeepingA.id }, (session) =>
        session.query("select id from public.outbox where tenant_id = $1;", [fixture.seed.orgId]),
      );
      expect(outboxRows).toHaveLength(0);

      const { rows: idemRows } = await fixture.engine.withAppSession({ userId: housekeepingA.id }, (session) =>
        session.query("select id from public.idempotency_key where tenant_id = $1;", [fixture.seed.orgId]),
      );
      expect(idemRows).toHaveLength(0);
    });

    it("housekeeping del Hotel Demo Centro no puede INSERTAR un outbox falsificado contra el Hotel Demo Playa", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const housekeepingA = hotelA.staff.find((s) => s.role === "housekeeping")!;

      await expect(
        fixture.engine.withAppSession({ userId: housekeepingA.id }, (session) =>
          session.query(
            `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
             values ($1, $2, 'payment', gen_random_uuid(), 'payment.recorded', '{"inyectado":true}');`,
            [fixture.seed.orgId, hotelB.id],
          ),
        ),
      ).rejects.toThrow();
    });

    it("gm (rol con acceso a dinero) del Hotel Demo Centro SÍ lee su propio outbox (no rompe el uso legítimo)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmA = hotelA.staff.find((s) => s.role === "gm")!;

      await fixture.engine.admin.query(
        `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
         values ($1, $2, 'reservation', gen_random_uuid(), 'reservation.created', '{}'::jsonb);`,
        [fixture.seed.orgId, hotelA.id],
      );

      const { rows } = await fixture.engine.withAppSession({ userId: gmA.id }, (session) =>
        session.query("select id from public.outbox where tenant_id = $1 and hotel_id = $2;", [
          fixture.seed.orgId,
          hotelA.id,
        ]),
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("[D-C1] room_type_id ya no puede cruzar hoteles en room/rate_plan/availability/reservation", () => {
    it("una sesión real de reservations no puede insertar availability con room_type de OTRO hotel", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const reservationsA = hotelA.staff.find((s) => s.role === "reservations")!;

      const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.org (name) values ('Org Competidora Ajena') returning id;",
      );
      const rivalOrgId = orgRows[0]!.id;
      const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Competidor') returning id;",
        [rivalOrgId],
      );
      const rivalHotelId = locRows[0]!.id;
      await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [
        rivalHotelId,
        rivalOrgId,
      ]);
      const { rows: rtRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.room_type (tenant_id, hotel_id, name) values ($1, $2, 'Suite Presidencial Secreta') returning id;",
        [rivalOrgId, rivalHotelId],
      );
      const rivalRoomTypeId = rtRows[0]!.id;

      await expect(
        fixture.engine.withAppSession({ userId: reservationsA.id }, (session) =>
          session.query(
            `insert into public.availability (tenant_id, hotel_id, room_type_id, date, total_rooms)
             values ($1, $2, $3, '2026-12-24', 1);`,
            [fixture.seed.orgId, hotelA.id, rivalRoomTypeId],
          ),
        ),
      ).rejects.toThrow();
    });

    it("el admin tampoco puede insertar (a nivel de esquema) un room/rate_plan/reservation cuyo room_type_id sea de otro hotel", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const roomTypeB = hotelB.roomTypes[0]!;

      await expect(
        fixture.engine.admin.query(
          "insert into public.room (tenant_id, hotel_id, room_type_id, code) values ($1, $2, $3, 'CRUZADO-1');",
          [fixture.seed.orgId, hotelA.id, roomTypeB.id],
        ),
      ).rejects.toThrow();

      await expect(
        fixture.engine.admin.query(
          "insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price) values ($1, $2, $3, '2026-12-24', 1000);",
          [fixture.seed.orgId, hotelA.id, roomTypeB.id],
        ),
      ).rejects.toThrow();
    });
  });

  describe("[D-C2] hotel_staff.org_id ya no se puede fabricar contra un org ajeno al hotel", () => {
    it("un owner real no puede dar de alta un colega con org_id de un tenant ajeno al hotel_id real", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const ownerA = hotelA.staff.find((s) => s.role === "owner")!;

      const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.org (name) values ('Org Víctima') returning id;",
      );
      const victimOrgId = orgRows[0]!.id;
      const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.staff_user (email, full_name) values ('nuevo@hotel-demo-centro.demo', 'Nuevo Empleado') returning id;",
      );
      const newUserId = userRows[0]!.id;

      const { rows: inserted } = await fixture.engine.withAppSession({ userId: ownerA.id }, (session) =>
        session.query<{ org_id: string }>(
          `insert into public.hotel_staff (org_id, hotel_id, user_id, role)
           values ($1, $2, $3, 'frontdesk') returning org_id;`,
          [victimOrgId, hotelA.id, newUserId],
        ),
      );

      // La fila se acepta (el owner sí tiene rol sobre hotel_id), pero org_id queda
      // DERIVADO del hotel real, nunca del valor fabricado -- el nuevo usuario nunca
      // obtiene current_tenant_ids() = Org Víctima.
      expect(inserted[0]!.org_id).toBe(fixture.seed.orgId);
      expect(inserted[0]!.org_id).not.toBe(victimOrgId);

      const { rows: visibleOrgs } = await fixture.engine.withAppSession({ userId: newUserId }, (session) =>
        session.query<{ id: string }>("select id from public.org where id = $1;", [victimOrgId]),
      );
      expect(visibleOrgs).toHaveLength(0);
    });
  });
});
