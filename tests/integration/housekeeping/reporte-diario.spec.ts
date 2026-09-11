// REQ-HK-010 · docs/ACEPTACION.md (criterio literal): "Reporte diario al gerente con
// minutos reales vs. estándar por camarista, habitaciones listas a hora objetivo,
// re-limpiezas, incidencias y tickets, generado automáticamente cada día (verificado
// con dataset de un día completo)." Contra embedded-postgres REAL (ADR-003) -- nunca un
// mock: la app Hono real de apps/api, las rutas reales de housekeeping, y un dataset de
// UN DÍA COMPLETO insertado directamente vía el cliente admin (mismo patrón que
// `back-office-cobros.spec.ts`/`housekeeping-mantenimiento.spec.ts` para fijar
// timestamps/actores que la API por sí sola no permite controlar con precisión, p.ej.
// `finished_at` exacto de una tarea).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_SEED_PASSWORD, hashPassword } from "@atiende-hoteles/db";
import { runReporteDiarioHotel } from "../../../scripts/housekeeping/reporte-diario.ts";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

const REPORT_DATE = "2026-01-15"; // día de negocio COMPLETO fijo, ajeno al reloj real de la corrida.

describe("REQ-HK-010: reporte diario de housekeeping al gerente (integración real)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let tenantId: string;
  let camaristaAId: string;
  let camaristaBId: string;
  let roomAId: string;
  let roomBId: string;
  let roomCId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    tenantId = fixture.seed.orgId;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
    camaristaAId = hotel.staff.find((s) => s.role === "housekeeping")!.id;

    // Segunda camarista real del mismo hotel -- el seed de desarrollo solo trae UNA por
    // rol (packages/db/src/seed.ts), y el reporte por camarista necesita al menos DOS
    // para probar que la agregación no las mezcla.
    const passwordHash = await hashPassword(DEV_SEED_PASSWORD);
    const { rows: camaristaBRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ($1, 'Segunda Camarista', $2) returning id;",
      ["segunda-camarista-hk010@example.com", passwordHash],
    );
    camaristaBId = camaristaBRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'housekeeping');",
      [tenantId, hotelId, camaristaBId],
    );

    const { rows: roomRows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room where hotel_id = $1 order by code limit 3;",
      [hotelId],
    );
    [roomAId, roomBId, roomCId] = roomRows.map((r) => r.id) as [string, string, string];
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}` });

  async function insertTask(params: {
    roomId: string;
    assignedTo: string | null;
    startedAt: string;
    finishedAt: string | null;
    status?: string;
    inspectionResult?: "aprobada" | "rechazada" | null;
  }): Promise<void> {
    await fixture.engine.admin.query(
      `insert into public.housekeeping_task
         (tenant_id, hotel_id, room_id, assigned_to, status, started_at, finished_at, inspection_result)
       values ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        tenantId,
        hotelId,
        params.roomId,
        params.assignedTo,
        params.status ?? "completada",
        params.startedAt,
        params.finishedAt,
        params.inspectionResult ?? null,
      ],
    );
  }

  it("configura la hora objetivo del hotel vía PATCH /housekeeping/config (solo owner/gm)", async () => {
    const patch = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/config`, {
      method: "PATCH",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ targetReadyTime: "15:00" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()) as { targetReadyTime: string }).toEqual({ targetReadyTime: "15:00:00" });

    const get = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/config`, { headers: authOf(ownerToken) });
    expect(get.status).toBe(200);
    expect((await get.json()) as { targetReadyTime: string }).toEqual({ targetReadyTime: "15:00:00" });

    // Rol operativo (no gerencial) NO puede leer/cambiar la config -- REQ-HK-010 es un
    // reporte "al gerente".
    const denegado = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/config`, {
      headers: authOf(housekeepingToken),
    });
    expect(denegado.status).toBe(403);
  });

  it("genera el reporte diario con dataset de un día completo: 5 métricas exactas del criterio de aceptación", async () => {
    // --- Camarista A: 2 habitaciones, ambas listas antes de las 15:00, una tuvo que
    // re-limpiarse tras una inspección rechazada (incidencia). ---
    await insertTask({
      roomId: roomAId,
      assignedTo: camaristaAId,
      startedAt: `${REPORT_DATE}T13:00:00.000Z`,
      finishedAt: `${REPORT_DATE}T13:25:00.000Z`, // 25 min reales (estándar 30 -> -5)
      inspectionResult: "rechazada",
    });
    await insertTask({
      roomId: roomAId,
      assignedTo: camaristaAId,
      startedAt: `${REPORT_DATE}T13:40:00.000Z`,
      finishedAt: `${REPORT_DATE}T14:00:00.000Z`, // re-limpieza, 20 min
    });
    await insertTask({
      roomId: roomBId,
      assignedTo: camaristaAId,
      startedAt: `${REPORT_DATE}T13:00:00.000Z`,
      finishedAt: `${REPORT_DATE}T14:00:00.000Z`, // 60 min reales (estándar 30 -> +30, lenta)
    });

    // --- Camarista B: 1 habitación, terminada DESPUÉS de la hora objetivo. ---
    await insertTask({
      roomId: roomCId,
      assignedTo: camaristaBId,
      startedAt: `${REPORT_DATE}T15:00:00.000Z`,
      finishedAt: `${REPORT_DATE}T15:20:00.000Z`,
    });

    // Tarea abierta (sin terminar) el mismo día: NO debe aportar minutos reales ni
    // contarse como habitación limpiada.
    await insertTask({ roomId: roomCId, assignedTo: camaristaBId, startedAt: `${REPORT_DATE}T20:00:00.000Z`, finishedAt: null, status: "en_progreso" });

    // Dos tickets de mantenimiento generados ese mismo día.
    await fixture.engine.admin.query(
      `insert into public.maintenance_ticket (tenant_id, hotel_id, room_id, title, description, created_at)
       values ($1, $2, $3, 'Foco fundido', 'Reportado al limpiar', $4),
              ($1, $2, $5, 'Llave gotea', 'Reportado al limpiar', $4);`,
      [tenantId, hotelId, roomAId, `${REPORT_DATE}T13:30:00.000Z`, roomBId],
    );
    // Ticket de OTRO día: no debe contarse en el reporte del día bajo prueba.
    await fixture.engine.admin.query(
      `insert into public.maintenance_ticket (tenant_id, hotel_id, room_id, title, description, created_at)
       values ($1, $2, $3, 'Ticket de otro día', 'no debe contar', '2026-01-16T10:00:00.000Z');`,
      [tenantId, hotelId, roomAId],
    );

    const post = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ fecha: REPORT_DATE }),
    });
    expect(post.status).toBe(201);
    const body = (await post.json()) as {
      reportDate: string;
      targetReadyTime: string;
      roomsCleaned: number;
      roomsReadyByTarget: number;
      reCleans: number;
      incidents: number;
      ticketsGenerated: number;
      camaristas: { staffUserId: string; fullName: string | null; roomsCleaned: number; actualMinutes: number; standardMinutes: number; varianceMinutes: number }[];
    };

    expect(body.reportDate).toBe(REPORT_DATE);
    expect(body.targetReadyTime).toBe("15:00:00");
    expect(body.roomsCleaned).toBe(3); // roomA, roomB, roomC (la en_progreso no cuenta)
    expect(body.roomsReadyByTarget).toBe(2); // roomA y roomB, no roomC (15:20 > 15:00)
    expect(body.reCleans).toBe(1); // roomA tuvo 2 tareas completadas ese día
    expect(body.incidents).toBe(1); // 1 inspección rechazada
    expect(body.ticketsGenerated).toBe(2); // NO cuenta el ticket del día siguiente

    const camA = body.camaristas.find((c) => c.staffUserId === camaristaAId)!;
    expect(camA.roomsCleaned).toBe(3);
    expect(camA.actualMinutes).toBe(25 + 20 + 60);
    expect(camA.standardMinutes).toBe(30 + 30 + 30);
    expect(camA.varianceMinutes).toBe(camA.actualMinutes - camA.standardMinutes);

    const camB = body.camaristas.find((c) => c.staffUserId === camaristaBId)!;
    expect(camB.roomsCleaned).toBe(1);
    expect(camB.actualMinutes).toBe(20);

    // Persistido de verdad (no solo la respuesta HTTP) -- consulta directa a la tabla.
    const { rows: persisted } = await fixture.engine.admin.query<{ rooms_cleaned: number; tickets_generated: number }>(
      "select rooms_cleaned, tickets_generated from public.housekeeping_daily_report where hotel_id = $1 and report_date = $2;",
      [hotelId, REPORT_DATE],
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.rooms_cleaned).toBe(3);
    expect(persisted[0]!.tickets_generated).toBe(2);
  });

  it("GET devuelve el snapshot ya persistido sin recalcular (mismo resultado que el POST)", async () => {
    const get = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario?fecha=${REPORT_DATE}`, {
      headers: authOf(ownerToken),
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { roomsCleaned: number; incidents: number };
    expect(body.roomsCleaned).toBe(3);
    expect(body.incidents).toBe(1);
  });

  it("GET de un día sin reporte generado responde 404, nunca inventa un reporte vacío", async () => {
    const get = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario?fecha=2026-02-01`, {
      headers: authOf(ownerToken),
    });
    expect(get.status).toBe(404);
  });

  it("regenerar el mismo día (POST de nuevo) sobrescribe el snapshot -- una tarea cerrada tarde SÍ corrige el reporte", async () => {
    await insertTask({
      roomId: roomAId,
      assignedTo: camaristaAId,
      startedAt: `${REPORT_DATE}T22:00:00.000Z`,
      finishedAt: `${REPORT_DATE}T22:30:00.000Z`,
    });

    const post = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ fecha: REPORT_DATE }),
    });
    expect(post.status).toBe(201);
    const body = (await post.json()) as { roomsCleaned: number; reCleans: number };
    // roomA ahora tuvo 3 tareas completadas ese día (2 anteriores + esta) -> reCleans sube a 2.
    expect(body.reCleans).toBe(2);
    expect(body.roomsCleaned).toBe(3);
  });

  it("caso negativo: rol operativo (housekeeping) NO puede generar ni leer el reporte del gerente", async () => {
    const post = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario`, {
      method: "POST",
      headers: { ...authOf(housekeepingToken), "content-type": "application/json" },
      body: JSON.stringify({ fecha: REPORT_DATE }),
    });
    expect(post.status).toBe(403);

    const get = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario?fecha=${REPORT_DATE}`, {
      headers: authOf(housekeepingToken),
    });
    expect(get.status).toBe(403);
  });

  it("caso negativo: fecha con formato inválido se rechaza con 400, nunca se interpreta a ciegas", async () => {
    const post = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ fecha: "15-01-2026" }),
    });
    expect(post.status).toBe(400);

    const get = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/reporte-diario?fecha=hoy`, {
      headers: authOf(gmToken),
    });
    expect(get.status).toBe(400);
  });

  it("el script operativo (cron real, scripts/housekeeping/reporte-diario.ts) usa la MISMA lógica y produce el mismo resultado", async () => {
    const [hotelRow] = fixture.seed.hotels;
    const resultado = await runReporteDiarioHotel(
      fixture.engine.admin,
      { id: hotelId, nombre: hotelRow!.name, tenantId },
      { date: REPORT_DATE },
    );
    expect(resultado.report.roomsCleaned).toBe(3);
    expect(resultado.report.reCleans).toBe(2);
    expect(resultado.report.incidents).toBe(1);
    expect(resultado.report.ticketsGenerated).toBe(2);
  });
});
