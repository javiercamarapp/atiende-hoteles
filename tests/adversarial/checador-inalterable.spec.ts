// REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): checador/registro de asistencia
// inalterable, cruzado contra el horario programado, exportable a la STPS -- ejercitado
// contra la API real (Hono + embedded-postgres, sesión RLS real por cada rol) en vez de
// llamar funciones SQL directo (ver tests/unit/attendance-log.spec.ts para eso).
//
// Cubre las 4 propiedades adversariales del requisito:
//  (a) INMUTABILIDAD: ni UPDATE ni DELETE se permiten, ni siquiera con el cliente admin.
//  (b) AUTOSERVICIO: nadie puede fichar la entrada/salida de otro empleado, ni
//      inyectando un `staffUserId` ajeno en el body.
//  (c) AISLAMIENTO: un empleado no puede fichar ni consultar asistencia de un hotel al
//      que no pertenece; un rol sin administración no puede ver/exportar la de otro
//      empleado.
//  (d) CRUCE Y ALERTA: horas trabajadas de más SIN autorización se marcan; dentro del
//      margen autorizado, no.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

async function checar(
  fixture: ApiFixture,
  token: string,
  hotelId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fixture.app.request(`/hoteles/${hotelId}/asistencia/checar`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("REQ-BO-024: checador de asistencia (append-only) + cruce contra horario", () => {
  let fixture: ApiFixture;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    hotelId = fixture.seed.hotels[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  describe("(a) inmutabilidad: ni UPDATE ni DELETE se permiten sobre attendance_log", () => {
    it("una fila registrada vía la API real no se puede alterar, ni con el cliente admin/propietario", async () => {
      const frontdesk = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const token = await loginAs(fixture.app, frontdesk.email);

      const res = await checar(fixture, token, hotelId, { eventType: "entrada" });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      await expect(
        fixture.engine.admin.query("update public.attendance_log set event_type = 'salida' where id = $1;", [id]),
      ).rejects.toThrow(/attendance_log_append_only/);

      await expect(
        fixture.engine.admin.query("delete from public.attendance_log where id = $1;", [id]),
      ).rejects.toThrow(/attendance_log_append_only/);

      const { rows } = await fixture.engine.admin.query<{ event_type: string }>(
        "select event_type from public.attendance_log where id = $1;",
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe("entrada");
    });

    it("no existe ninguna ruta HTTP de edición/borrado sobre un registro de asistencia (PATCH/PUT/DELETE 404)", async () => {
      const frontdesk = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const token = await loginAs(fixture.app, frontdesk.email);
      const created = await checar(fixture, token, hotelId, { eventType: "entrada" });
      const { id } = (await created.json()) as { id: string };

      for (const method of ["PATCH", "PUT", "DELETE"]) {
        const res = await fixture.app.request(`/hoteles/${hotelId}/asistencia/${id}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(404);
      }
    });
  });

  describe("(b) autoservicio: nadie puede fichar la entrada/salida de OTRO empleado", () => {
    it("un intento de inyectar un staffUserId ajeno en el body se ignora: la fila queda a nombre de quien inició sesión", async () => {
      const housekeeping = fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!;
      const gm = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
      const token = await loginAs(fixture.app, housekeeping.email);

      const res = await checar(fixture, token, hotelId, {
        eventType: "entrada",
        staffUserId: gm.id, // campo que el endpoint no acepta -- se descarta, no se usa.
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { staffUserId: string };
      expect(body.staffUserId).toBe(housekeeping.id);
      expect(body.staffUserId).not.toBe(gm.id);
    });
  });

  describe("(c) aislamiento: hotel ajeno y roles sin administración", () => {
    it("un empleado no puede fichar asistencia en un hotel al que no pertenece", async () => {
      const hotelB = fixture.seed.hotels[1]!.id;
      const frontdeskA = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const token = await loginAs(fixture.app, frontdeskA.email);

      const res = await checar(fixture, token, hotelB, { eventType: "entrada" });
      expect(res.status).toBe(403);
    });

    it("un rol sin administración no puede consultar la asistencia de OTRO empleado (403 explícito, no una lista vacía)", async () => {
      const housekeeping = fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!;
      const frontdesk = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const token = await loginAs(fixture.app, housekeeping.email);

      const res = await fixture.app.request(
        `/hoteles/${hotelId}/asistencia?staffUserId=${frontdesk.id}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(403);
    });

    it("un rol sin administración SÍ puede consultar su propio historial", async () => {
      const housekeeping = fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!;
      const token = await loginAs(fixture.app, housekeeping.email);
      await checar(fixture, token, hotelId, { eventType: "entrada" });

      const res = await fixture.app.request(`/hoteles/${hotelId}/asistencia`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as { staffUserId: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.staffUserId === housekeeping.id)).toBe(true);
    });

    it("un rol sin administración NO puede programar horarios de otro empleado", async () => {
      const housekeeping = fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!;
      const frontdesk = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const token = await loginAs(fixture.app, housekeeping.email);

      const res = await fixture.app.request(`/hoteles/${hotelId}/asistencia/horarios`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          staffUserId: frontdesk.id,
          workDate: "2026-09-10",
          scheduledStart: "2026-09-10T14:00:00Z",
          scheduledEnd: "2026-09-10T22:00:00Z",
        }),
      });
      expect(res.status).toBe(403);
    });

    it("un rol sin administración NO puede exportar el CSV para la STPS", async () => {
      const housekeeping = fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!;
      const token = await loginAs(fixture.app, housekeeping.email);

      const res = await fixture.app.request(
        `/hoteles/${hotelId}/asistencia/exportar-stps?desde=2026-09-01&hasta=2026-09-30`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("(d) cruce contra horario programado: alerta de horas extra NO autorizadas", () => {
    it("horas extra dentro del margen autorizado no alertan; el excedente real sí, y solo por el excedente", async () => {
      const gm = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
      const frontdesk = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!;
      const gmToken = await loginAs(fixture.app, gm.email);

      // Programa el turno vía la API real (gm/owner) con 30 min pre-autorizados.
      const horarioRes = await fixture.app.request(`/hoteles/${hotelId}/asistencia/horarios`, {
        method: "POST",
        headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          staffUserId: frontdesk.id,
          workDate: "2026-09-10",
          scheduledStart: "2026-09-10T14:00:00Z",
          scheduledEnd: "2026-09-10T22:00:00Z",
          authorizedOvertimeMinutes: 30,
        }),
      });
      expect(horarioRes.status).toBe(201);

      // El checador registra timestamps del servidor (`now()`), no los que mande el
      // cliente -- correcto para un registro inalterable de verdad, pero significa que
      // un turno de 9.5h no se puede simular esperando en tiempo real dentro de una
      // prueba. Se insertan los DOS eventos directamente como setup de fixture (mismo
      // criterio que tests/adversarial/roles.spec.ts insertando la reserva/folio de
      // prueba directo con el cliente admin) -- lo que se ejercita end-to-end es la
      // RUTA de lectura (/cruce, /exportar-stps), no la de escritura (ya cubierta en
      // (a)/(b)/(c) arriba y en tests/unit/attendance-log.spec.ts).
      await fixture.engine.admin.query(
        `insert into public.attendance_log (hotel_id, staff_user_id, event_type, recorded_at)
         values ($1, $2, 'entrada', $3), ($1, $2, 'salida', $4);`,
        [hotelId, frontdesk.id, "2026-09-10T14:00:00Z", "2026-09-10T23:30:00Z"], // +90 min sobre lo programado
      );

      const cruceRes = await fixture.app.request(
        `/hoteles/${hotelId}/asistencia/cruce?staffUserId=${frontdesk.id}&desde=2026-09-10&hasta=2026-09-10`,
        { headers: { authorization: `Bearer ${gmToken}` } },
      );
      expect(cruceRes.status).toBe(200);
      const [entry] = (await cruceRes.json()) as {
        estado: string;
        horasProgramadas: number;
        horasTrabajadas: number;
        horasExtraAutorizadas: number;
        horasExtraNoAutorizadas: number;
        alerta: boolean;
      }[];
      expect(entry).toBeDefined();
      expect(entry!.estado).toBe("completo");
      expect(entry!.horasProgramadas).toBe(8);
      expect(entry!.horasTrabajadas).toBe(9.5);
      expect(entry!.horasExtraAutorizadas).toBe(0.5);
      // 90 min de excedente - 30 min autorizados = 60 min = 1h no autorizada.
      expect(entry!.horasExtraNoAutorizadas).toBe(1);
      expect(entry!.alerta).toBe(true);

      // El mismo cruce, en el CSV para la STPS: la fila existe y trae el mismo
      // excedente no autorizado.
      const csvRes = await fixture.app.request(
        `/hoteles/${hotelId}/asistencia/exportar-stps?staffUserId=${frontdesk.id}&desde=2026-09-10&hasta=2026-09-10`,
        { headers: { authorization: `Bearer ${gmToken}` } },
      );
      expect(csvRes.status).toBe(200);
      expect(csvRes.headers.get("content-type")).toContain("text/csv");
      const csv = await csvRes.text();
      const lines = csv.trim().split("\r\n");
      expect(lines[0]).toContain("horas_extra_no_autorizadas");
      expect(lines[1]).toContain("HDC010101AB1"); // rfc_emisor sembrado por seedDev para Hotel Demo Centro
      expect(lines[1]).toContain("1.00,completo");
    });

    it("trabajar un día SIN ningún horario programado marca el 100% de lo trabajado como no autorizado", async () => {
      const gm = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!;
      const accountant = fixture.seed.hotels[0]!.staff.find((s) => s.role === "accountant")!;
      const gmToken = await loginAs(fixture.app, gm.email);

      await fixture.engine.admin.query(
        `insert into public.attendance_log (hotel_id, staff_user_id, event_type, recorded_at)
         values ($1, $2, 'entrada', $3), ($1, $2, 'salida', $4);`,
        [hotelId, accountant.id, "2026-09-11T09:00:00Z", "2026-09-11T13:00:00Z"],
      );

      const res = await fixture.app.request(
        `/hoteles/${hotelId}/asistencia/cruce?staffUserId=${accountant.id}&desde=2026-09-11&hasta=2026-09-11`,
        { headers: { authorization: `Bearer ${gmToken}` } },
      );
      const [entry] = (await res.json()) as { estado: string; horasExtraNoAutorizadas: number; alerta: boolean }[];
      expect(entry!.estado).toBe("sin_horario");
      expect(entry!.horasExtraNoAutorizadas).toBe(4);
      expect(entry!.alerta).toBe(true);
    });
  });
});
