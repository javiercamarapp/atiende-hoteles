// REQ-HK-010: "El sistema debe generar un reporte diario al gerente con minutos reales
// vs. estándar por camarista, habitaciones listas a una hora objetivo, re-limpiezas,
// incidencias y tickets generados." Pruebas del cálculo puro -- la orquestación real
// contra Postgres vive en tests/integration/housekeeping/reporte-diario.spec.ts.
import { describe, expect, it } from "vitest";
import {
  HousekeepingReportError,
  assertValidReportDate,
  assertValidTargetReadyTime,
  buildHousekeepingDailyReport,
  resolveBusinessDayWindow,
  type HousekeepingTaskRecord,
} from "@atiende-hoteles/domain-hotel";

const REPORT_DATE = "2026-09-09";

function task(overrides: Partial<HousekeepingTaskRecord> = {}): HousekeepingTaskRecord {
  return {
    taskId: "task-1",
    roomId: "room-1",
    assignedTo: "staff-1",
    assignedFullName: "María Pérez",
    standardMinutes: 30,
    status: "completada",
    startedAt: `${REPORT_DATE}T14:00:00.000Z`,
    finishedAt: `${REPORT_DATE}T14:25:00.000Z`,
    inspectionResult: null,
    ...overrides,
  };
}

describe("assertValidTargetReadyTime", () => {
  it("normaliza HH:MM a HH:MM:SS", () => {
    expect(assertValidTargetReadyTime("15:00")).toBe("15:00:00");
  });
  it("acepta HH:MM:SS tal cual", () => {
    expect(assertValidTargetReadyTime("15:30:45")).toBe("15:30:45");
  });
  it("rechaza una hora inválida (nunca asume un default silencioso)", () => {
    expect(() => assertValidTargetReadyTime("25:99")).toThrow(HousekeepingReportError);
    expect(() => assertValidTargetReadyTime("no-es-hora")).toThrow(HousekeepingReportError);
  });
});

describe("assertValidReportDate / resolveBusinessDayWindow", () => {
  it("rechaza una fecha con formato inválido", () => {
    expect(() => assertValidReportDate("09-09-2026")).toThrow(HousekeepingReportError);
  });
  it("la ventana cubre exactamente 24h UTC del día", () => {
    const { start, end } = resolveBusinessDayWindow(REPORT_DATE);
    expect(start.toISOString()).toBe(`${REPORT_DATE}T00:00:00.000Z`);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("buildHousekeepingDailyReport: caso feliz con dataset de un día completo", () => {
  it("calcula las 5 métricas exigidas por el criterio de aceptación", () => {
    const report = buildHousekeepingDailyReport({
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 2,
      tasks: [
        // María: 2 habitaciones, ambas listas antes de las 15:00, sin incidencias.
        task({ taskId: "t1", roomId: "room-101", startedAt: `${REPORT_DATE}T13:00:00.000Z`, finishedAt: `${REPORT_DATE}T13:25:00.000Z`, standardMinutes: 30 }),
        task({ taskId: "t2", roomId: "room-102", startedAt: `${REPORT_DATE}T13:30:00.000Z`, finishedAt: `${REPORT_DATE}T14:10:00.000Z`, standardMinutes: 30 }),
        // Juan: 1 habitación, terminada DESPUÉS de la hora objetivo.
        task({
          taskId: "t3",
          roomId: "room-201",
          assignedTo: "staff-2",
          assignedFullName: "Juan López",
          startedAt: `${REPORT_DATE}T15:00:00.000Z`,
          finishedAt: `${REPORT_DATE}T15:40:00.000Z`,
          standardMinutes: 45,
        }),
        // room-101 se re-limpia (inspección rechazada -> incidencia + re-limpieza).
        task({
          taskId: "t1-inspeccion-rechazada",
          roomId: "room-101",
          assignedTo: "staff-1",
          assignedFullName: "María Pérez",
          startedAt: `${REPORT_DATE}T13:00:00.000Z`,
          finishedAt: `${REPORT_DATE}T13:10:00.000Z`,
          inspectionResult: "rechazada",
          standardMinutes: 30,
        }),
        task({
          taskId: "t1-relimpieza",
          roomId: "room-101",
          assignedTo: "staff-1",
          assignedFullName: "María Pérez",
          startedAt: `${REPORT_DATE}T14:20:00.000Z`,
          finishedAt: `${REPORT_DATE}T14:35:00.000Z`,
          standardMinutes: 30,
        }),
        // Tarea cancelada: no debe contar en NINGUNA métrica.
        task({ taskId: "t-cancelada", roomId: "room-999", status: "cancelada", startedAt: null, finishedAt: null }),
      ],
    });

    expect(report.roomsCleaned).toBe(3); // room-101, room-102, room-201
    expect(report.roomsReadyByTarget).toBe(2); // room-101 y room-102 (ambas <=15:00 en alguna tarea)
    expect(report.reCleans).toBe(2); // room-101 tuvo 3 tareas completadas = 2 de excedente
    expect(report.incidents).toBe(1); // 1 inspección rechazada
    expect(report.ticketsGenerated).toBe(2); // pass-through de maintenanceTicketsCreated

    const maria = report.camaristas.find((c) => c.staffUserId === "staff-1")!;
    expect(maria.roomsCleaned).toBe(4); // t1, t2, t1-inspeccion-rechazada, t1-relimpieza
    expect(maria.actualMinutes).toBe(25 + 40 + 10 + 15);
    expect(maria.standardMinutes).toBe(30 + 30 + 30 + 30);
    expect(maria.varianceMinutes).toBe(maria.actualMinutes - maria.standardMinutes);

    const juan = report.camaristas.find((c) => c.staffUserId === "staff-2")!;
    expect(juan.roomsCleaned).toBe(1);
    expect(juan.actualMinutes).toBe(40);
    expect(juan.standardMinutes).toBe(45);
    expect(juan.varianceMinutes).toBe(-5); // más rápido que el estándar -- señal útil, no se recorta a 0
  });

  it("una camarista más lenta que el estándar tiene varianceMinutes positivo", () => {
    const report = buildHousekeepingDailyReport({
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 0,
      tasks: [task({ startedAt: `${REPORT_DATE}T10:00:00.000Z`, finishedAt: `${REPORT_DATE}T11:00:00.000Z`, standardMinutes: 30 })],
    });
    expect(report.camaristas[0]!.varianceMinutes).toBe(30); // 60 reales - 30 estándar
  });

  it("tareas sin asignar se agrupan en 'sin_asignar', nunca se le atribuyen a una camarista al azar", () => {
    const report = buildHousekeepingDailyReport({
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 0,
      tasks: [task({ assignedTo: null, assignedFullName: null })],
    });
    expect(report.camaristas).toHaveLength(1);
    expect(report.camaristas[0]!.staffUserId).toBe("sin_asignar");
    expect(report.camaristas[0]!.fullName).toBeNull();
  });

  it("una tarea en_progreso o pendiente no aporta minutos reales ni cuenta como habitación limpiada", () => {
    const report = buildHousekeepingDailyReport({
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 0,
      tasks: [
        task({ status: "en_progreso", finishedAt: null }),
        task({ taskId: "t2", roomId: "room-2", status: "pendiente", startedAt: null, finishedAt: null }),
      ],
    });
    expect(report.roomsCleaned).toBe(0);
    expect(report.camaristas).toHaveLength(0);
  });

  it("sin ninguna tarea, el reporte es todo-ceros pero válido (día sin operación, no un error)", () => {
    const report = buildHousekeepingDailyReport({
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 0,
      tasks: [],
    });
    expect(report).toMatchObject({
      roomsCleaned: 0,
      roomsReadyByTarget: 0,
      reCleans: 0,
      incidents: 0,
      ticketsGenerated: 0,
      camaristas: [],
    });
  });

  it("caso negativo: una tarea 'completada' con finished_at fuera del día reportado lanza, nunca se cuenta bajo el día equivocado", () => {
    expect(() =>
      buildHousekeepingDailyReport({
        hotelId: "hotel-1",
        reportDate: REPORT_DATE,
        targetReadyTime: "15:00",
        maintenanceTicketsCreated: 0,
        tasks: [task({ finishedAt: "2026-09-10T01:00:00.000Z" })],
      }),
    ).toThrow(/tarea_fuera_de_fecha|fuera del día reportado/);
  });

  it("caso negativo: started_at posterior a finished_at lanza en vez de reportar minutos negativos", () => {
    expect(() =>
      buildHousekeepingDailyReport({
        hotelId: "hotel-1",
        reportDate: REPORT_DATE,
        targetReadyTime: "15:00",
        maintenanceTicketsCreated: 0,
        tasks: [task({ startedAt: `${REPORT_DATE}T16:00:00.000Z`, finishedAt: `${REPORT_DATE}T14:00:00.000Z` })],
      }),
    ).toThrow(HousekeepingReportError);
  });

  it("caso negativo: maintenanceTicketsCreated negativo lanza en vez de reportar un conteo imposible", () => {
    expect(() =>
      buildHousekeepingDailyReport({
        hotelId: "hotel-1",
        reportDate: REPORT_DATE,
        targetReadyTime: "15:00",
        maintenanceTicketsCreated: -1,
        tasks: [],
      }),
    ).toThrow(HousekeepingReportError);
  });

  it("es determinístico: la misma entrada produce siempre la misma salida", () => {
    const input = {
      hotelId: "hotel-1",
      reportDate: REPORT_DATE,
      targetReadyTime: "15:00",
      maintenanceTicketsCreated: 3,
      tasks: [task(), task({ taskId: "t2", roomId: "room-2", assignedTo: "staff-2", assignedFullName: "Juan" })],
    };
    expect(buildHousekeepingDailyReport(input)).toEqual(buildHousekeepingDailyReport(input));
  });
});
