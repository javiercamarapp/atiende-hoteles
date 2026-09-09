// REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): cruce puro de lo trabajado (checador)
// contra lo programado (horario), sin tocar Postgres -- ver
// tests/unit/attendance-log.spec.ts (inmutabilidad/cadena de hash contra PGlite) y
// tests/adversarial/checador-inalterable.spec.ts (recorrido completo vía API real).
import { describe, expect, it } from "vitest";
import {
  buildStpsAttendanceCsv,
  crossCheckAttendance,
  pairAttendanceEvents,
  type AttendanceEvent,
  type AttendanceSchedule,
} from "@atiende-hoteles/domain-hotel";

const schedule = (overrides: Partial<AttendanceSchedule> = {}): AttendanceSchedule => ({
  scheduledStart: "2026-09-08T14:00:00.000Z",
  scheduledEnd: "2026-09-08T22:00:00.000Z", // turno de 8h
  authorizedOvertimeMinutes: 0,
  ...overrides,
});

describe("pairAttendanceEvents: empareja entrada/salida en turnos", () => {
  it("una sola entrada+salida produce un turno cerrado con los minutos correctos", () => {
    const events: AttendanceEvent[] = [
      { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
      { eventType: "salida", recordedAt: "2026-09-08T22:00:00.000Z" },
    ];
    const { shifts, anomalies } = pairAttendanceEvents(events);
    expect(shifts).toEqual([
      { startedAt: "2026-09-08T14:00:00.000Z", endedAt: "2026-09-08T22:00:00.000Z", workedMinutes: 480 },
    ]);
    expect(anomalies).toEqual([]);
  });

  it("ordena los eventos aunque lleguen fuera de orden (recordedAt manda, no el orden de llegada)", () => {
    const events: AttendanceEvent[] = [
      { eventType: "salida", recordedAt: "2026-09-08T22:00:00.000Z" },
      { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
    ];
    const { shifts } = pairAttendanceEvents(events);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.workedMinutes).toBe(480);
  });

  it("una entrada sin salida queda como turno abierto (workedMinutes null)", () => {
    const events: AttendanceEvent[] = [{ eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" }];
    const { shifts } = pairAttendanceEvents(events);
    expect(shifts).toEqual([{ startedAt: "2026-09-08T14:00:00.000Z", endedAt: null, workedMinutes: null }]);
  });

  it("una salida sin entrada previa se reporta como anomalía, nunca se inventa una entrada", () => {
    const events: AttendanceEvent[] = [{ eventType: "salida", recordedAt: "2026-09-08T22:00:00.000Z" }];
    const { shifts, anomalies } = pairAttendanceEvents(events);
    expect(shifts).toEqual([]);
    expect(anomalies).toEqual([{ type: "salida_sin_entrada_abierta", at: "2026-09-08T22:00:00.000Z" }]);
  });

  it("dos entradas seguidas: la segunda se reporta como duplicada y se ignora para el cálculo", () => {
    const events: AttendanceEvent[] = [
      { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
      { eventType: "entrada", recordedAt: "2026-09-08T15:00:00.000Z" },
      { eventType: "salida", recordedAt: "2026-09-08T22:00:00.000Z" },
    ];
    const { shifts, anomalies } = pairAttendanceEvents(events);
    expect(shifts).toEqual([
      { startedAt: "2026-09-08T14:00:00.000Z", endedAt: "2026-09-08T22:00:00.000Z", workedMinutes: 480 },
    ]);
    expect(anomalies).toEqual([{ type: "entrada_duplicada", at: "2026-09-08T15:00:00.000Z" }]);
  });

  it("dos turnos el mismo día (con descanso) se emparejan y suman por separado", () => {
    const events: AttendanceEvent[] = [
      { eventType: "entrada", recordedAt: "2026-09-08T08:00:00.000Z" },
      { eventType: "salida", recordedAt: "2026-09-08T12:00:00.000Z" },
      { eventType: "entrada", recordedAt: "2026-09-08T13:00:00.000Z" },
      { eventType: "salida", recordedAt: "2026-09-08T17:00:00.000Z" },
    ];
    const { shifts } = pairAttendanceEvents(events);
    expect(shifts).toHaveLength(2);
    expect(shifts[0]!.workedMinutes).toBe(240);
    expect(shifts[1]!.workedMinutes).toBe(240);
  });
});

describe("crossCheckAttendance: horas extra no autorizadas (REQ-BO-024)", () => {
  it("trabajar exactamente lo programado no genera ninguna alerta", () => {
    const result = crossCheckAttendance({
      schedule: schedule(),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T22:00:00.000Z" },
      ],
    });
    expect(result.status).toBe("completo");
    expect(result.scheduledMinutes).toBe(480);
    expect(result.workedMinutes).toBe(480);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.unauthorizedOvertimeMinutes).toBe(0);
    expect(result.alert).toBe(false);
  });

  it("salir 90 minutos tarde sin ninguna autorización marca alerta con el excedente exacto", () => {
    const result = crossCheckAttendance({
      schedule: schedule({ authorizedOvertimeMinutes: 0 }),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T23:30:00.000Z" }, // +90 min
      ],
    });
    expect(result.overtimeMinutes).toBe(90);
    expect(result.unauthorizedOvertimeMinutes).toBe(90);
    expect(result.alert).toBe(true);
  });

  it("horas extra DENTRO del margen pre-autorizado no generan alerta", () => {
    const result = crossCheckAttendance({
      schedule: schedule({ authorizedOvertimeMinutes: 120 }),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T23:30:00.000Z" }, // +90 min, autorizado hasta 120
      ],
    });
    expect(result.overtimeMinutes).toBe(90);
    expect(result.unauthorizedOvertimeMinutes).toBe(0);
    expect(result.alert).toBe(false);
  });

  it("horas extra que EXCEDEN el margen autorizado marcan solo el excedente real como no autorizado", () => {
    const result = crossCheckAttendance({
      schedule: schedule({ authorizedOvertimeMinutes: 30 }),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T23:30:00.000Z" }, // +90 min, autorizado 30
      ],
    });
    expect(result.overtimeMinutes).toBe(90);
    expect(result.unauthorizedOvertimeMinutes).toBe(60);
    expect(result.alert).toBe(true);
  });

  it("salir antes de lo programado nunca produce horas extra negativas", () => {
    const result = crossCheckAttendance({
      schedule: schedule(),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T20:00:00.000Z" }, // 2h antes
      ],
    });
    expect(result.overtimeMinutes).toBe(0);
    expect(result.unauthorizedOvertimeMinutes).toBe(0);
    expect(result.alert).toBe(false);
  });

  it("un turno todavía abierto no se marca en alerta prematuramente (status en_curso)", () => {
    const result = crossCheckAttendance({
      schedule: schedule({ authorizedOvertimeMinutes: 0 }),
      events: [{ eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" }],
    });
    expect(result.status).toBe("en_curso");
    expect(result.alert).toBe(false);
    expect(result.unauthorizedOvertimeMinutes).toBe(0);
  });

  it("trabajar sin NINGÚN horario programado marca TODO lo trabajado como no autorizado", () => {
    const result = crossCheckAttendance({
      schedule: null,
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T18:00:00.000Z" },
      ],
    });
    expect(result.status).toBe("sin_horario");
    expect(result.scheduledMinutes).toBeNull();
    expect(result.workedMinutes).toBe(240);
    expect(result.unauthorizedOvertimeMinutes).toBe(240);
    expect(result.alert).toBe(true);
  });

  it("sin horario y sin ningún evento no genera una alerta fantasma (nada trabajado, nada que alertar)", () => {
    const result = crossCheckAttendance({ schedule: null, events: [] });
    expect(result.status).toBe("sin_horario");
    expect(result.workedMinutes).toBe(0);
    expect(result.unauthorizedOvertimeMinutes).toBe(0);
    expect(result.alert).toBe(false);
  });
});

describe("buildStpsAttendanceCsv: exportación art. 132 fr. XXXIV LFT", () => {
  it("produce un CSV con encabezado, una fila por turno y los minutos convertidos a horas", () => {
    const result = crossCheckAttendance({
      schedule: schedule({ authorizedOvertimeMinutes: 30 }),
      events: [
        { eventType: "entrada", recordedAt: "2026-09-08T14:00:00.000Z" },
        { eventType: "salida", recordedAt: "2026-09-08T23:30:00.000Z" },
      ],
    });

    const csv = buildStpsAttendanceCsv(
      [{ staffUserId: "staff-1", fullName: "Empleado Uno", email: "e1@demo.mx", workDate: "2026-09-08", result }],
      "HDC010101AB1",
    );

    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "rfc_patronal,empleado,correo,fecha,entrada_programada,salida_programada,entrada_real,salida_real,horas_programadas,horas_trabajadas,horas_extra_autorizadas,horas_extra_no_autorizadas,estado",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "HDC010101AB1,Empleado Uno,e1@demo.mx,2026-09-08,2026-09-08T14:00:00.000Z,2026-09-08T22:00:00.000Z,2026-09-08T14:00:00.000Z,2026-09-08T23:30:00.000Z,8.00,9.50,0.50,1.00,completo",
    );
  });

  it("escapa comas y comillas en el nombre del empleado (RFC 4180)", () => {
    const result = crossCheckAttendance({ schedule: null, events: [] });
    const csv = buildStpsAttendanceCsv(
      [{ staffUserId: "s1", fullName: 'Pérez, "Juan"', email: "j@demo.mx", workDate: "2026-09-08", result }],
      "HDC010101AB1",
    );
    expect(csv).toContain('"Pérez, ""Juan"""');
  });

  it("un día sin ningún turno registrado igual produce una fila (ausencia visible, no desaparece del reporte)", () => {
    const result = crossCheckAttendance({ schedule: schedule(), events: [] });
    const csv = buildStpsAttendanceCsv(
      [{ staffUserId: "s1", fullName: "Empleado Ausente", email: "a@demo.mx", workDate: "2026-09-08", result }],
      "HDC010101AB1",
    );
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Empleado Ausente");
    expect(lines[1]).toContain("8.00,0.00,0.00,0.00,completo");
  });
});
