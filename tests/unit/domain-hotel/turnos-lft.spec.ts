// REQ-HK-008 (P1/GOB): la plantilla de turnos de housekeeping/lavandería propuesta debe
// validarse contra la LFT (descansos, límite de horas, transición a jornada de 40h)
// antes de publicarse. Cruce puro (sin Postgres), mismo criterio que
// tests/unit/domain-hotel/attendance.spec.ts (REQ-BO-024).
import { describe, expect, it } from "vitest";
import {
  assertTurnosLftPublishable,
  classifyShiftType,
  ordinaryDailyLimitMinutes,
  shiftDurationMinutes,
  TurnosLftViolationError,
  validateTurnosLft,
  type ProposedShift,
  type WeeklyHourLimitMilestone,
} from "@atiende-hoteles/domain-hotel";

function shift(staffId: string, workDate: string, startTime: string, endTime: string): ProposedShift {
  return { staffId, workDate, startTime, endTime };
}

/** Lunes 2026-09-07 .. domingo 2026-09-13 (semana ISO completa, para pruebas de límites
 *  semanales sin depender de en qué día del año caiga "hoy"). */
const MON = "2026-09-07";
const TUE = "2026-09-08";
const WED = "2026-09-09";
const THU = "2026-09-10";
const FRI = "2026-09-11";
const SAT = "2026-09-12";
const SUN = "2026-09-13";

describe("classifyShiftType: Art. 60 diurna/nocturna/mixta", () => {
  it("un turno 09:00-17:00 (todo horas de sol) es diurna", () => {
    expect(classifyShiftType("09:00", "17:00")).toBe("diurna");
  });

  it("un turno 23:00-06:00 (todo dentro de 20:00-06:00) es nocturna", () => {
    expect(classifyShiftType("23:00", "06:00")).toBe("nocturna");
  });

  it("un turno con >= 3h30 dentro de horario nocturno se reputa nocturna aunque empiece de día", () => {
    // 18:00-01:30: nocturno = 20:00-01:30 = 5.5h >= 3.5h -> nocturna entera (Art. 60).
    expect(classifyShiftType("18:00", "01:30")).toBe("nocturna");
  });

  it("un turno con menos de 3h30 nocturnas es mixta", () => {
    // 18:00-22:00: nocturno = 20:00-22:00 = 2h < 3.5h -> mixta.
    expect(classifyShiftType("18:00", "22:00")).toBe("mixta");
  });

  it("rechaza una hora mal formada", () => {
    expect(() => classifyShiftType("25:00", "10:00")).toThrow(RangeError);
    expect(() => classifyShiftType("9:00", "10:00")).toThrow(RangeError);
  });
});

describe("shiftDurationMinutes / ordinaryDailyLimitMinutes", () => {
  it("calcula duración normal y duración que cruza medianoche", () => {
    expect(shiftDurationMinutes("09:00", "17:00")).toBe(8 * 60);
    expect(shiftDurationMinutes("22:00", "06:00")).toBe(8 * 60);
  });

  it("expone los límites diarios del art. 61 por tipo de jornada", () => {
    expect(ordinaryDailyLimitMinutes("diurna")).toBe(8 * 60);
    expect(ordinaryDailyLimitMinutes("nocturna")).toBe(7 * 60);
    expect(ordinaryDailyLimitMinutes("mixta")).toBe(7.5 * 60);
  });
});

describe("validateTurnosLft: plantilla que SÍ cumple la LFT", () => {
  it("6 turnos diurnos de 8h (lunes a sábado) + domingo de descanso: sin violaciones", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED, THU, FRI, SAT].map((d) => shift("camarista-1", d, "08:00", "16:00"));
    const result = validateTurnosLft({ shifts });
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("no publicar no lanza cuando la plantilla es legal", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED].map((d) => shift("camarista-1", d, "08:00", "16:00"));
    expect(() => assertTurnosLftPublishable({ shifts })).not.toThrow();
  });
});

describe("validateTurnosLft: jornada diaria excedida (Art. 61 + 66)", () => {
  it("un turno diurno de 12h (4h extra, > 3h permitidas) se rechaza citando el artículo", () => {
    const shifts: ProposedShift[] = [shift("camarista-1", MON, "08:00", "20:00")];
    const result = validateTurnosLft({ shifts });
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: "jornada_diaria_excedida",
      staffId: "camarista-1",
      article: "LFT art. 61 y 66",
      scope: { workDate: MON },
    });
    expect(result.violations[0]!.message).toContain("art. 66");
  });

  it("un turno diurno de exactamente 3h extra (11h) NO viola el tope diario", () => {
    const shifts: ProposedShift[] = [shift("camarista-1", MON, "08:00", "19:00")];
    const result = validateTurnosLft({ shifts });
    expect(result.violations.some((v) => v.type === "jornada_diaria_excedida")).toBe(false);
  });

  it("suma turnos partidos del mismo día para la jornada diaria total", () => {
    // 08:00-13:00 (5h) + 14:00-21:00 (7h) = 12h el mismo día -> 4h extra sobre 8h diurna.
    const shifts: ProposedShift[] = [
      shift("camarista-1", MON, "08:00", "13:00"),
      shift("camarista-1", MON, "14:00", "21:00"),
    ];
    const result = validateTurnosLft({ shifts });
    expect(result.violations.some((v) => v.type === "jornada_diaria_excedida")).toBe(true);
  });

  it("assertTurnosLftPublishable lanza TurnosLftViolationError con las violaciones adjuntas", () => {
    const shifts: ProposedShift[] = [shift("camarista-1", MON, "08:00", "22:00")];
    expect(() => assertTurnosLftPublishable({ shifts })).toThrow(TurnosLftViolationError);
    try {
      assertTurnosLftPublishable({ shifts });
      expect.fail("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(TurnosLftViolationError);
      const violationError = err as TurnosLftViolationError;
      expect(violationError.violations).toHaveLength(1);
      expect(violationError.message).toContain("LFT art. 61 y 66");
    }
  });
});

describe("validateTurnosLft: horas extra semanales excedidas (Art. 66/68)", () => {
  it("más de 3 días con extra en la semana se rechaza aunque cada día esté dentro del tope diario", () => {
    // 4 días de 10h (2h extra c/u, dentro del tope diario de 3h) = 4 días con extra > 3 permitidos.
    const shifts: ProposedShift[] = [MON, TUE, WED, THU].map((d) => shift("camarista-1", d, "08:00", "18:00"));
    const result = validateTurnosLft({ shifts });
    const v = result.violations.find((x) => x.type === "horas_extra_semanales_excedidas");
    expect(v).toBeDefined();
    expect(v?.article).toBe("LFT art. 66 y 68");
  });

  it("más de 9h extra en la semana se rechaza aunque sean solo 3 días", () => {
    // 3 días de 12h (4h extra c/u) = 12h extra/semana > 9h permitidas, aunque solo son 3 días.
    const shifts: ProposedShift[] = [MON, TUE, WED].map((d) => shift("camarista-1", d, "08:00", "20:00"));
    const result = validateTurnosLft({ shifts });
    // Aquí también dispara jornada_diaria_excedida (4h > 3h/día) -- lo relevante es que
    // el semanal se reporta AL MENOS una vez además del diario.
    const v = result.violations.find((x) => x.type === "horas_extra_semanales_excedidas");
    expect(v).toBeDefined();
  });

  it("3 días con 2h extra (6h/semana, dentro de 3 días y 9h) NO viola el tope semanal", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED].map((d) => shift("camarista-1", d, "08:00", "18:00"));
    const result = validateTurnosLft({ shifts });
    expect(result.violations.some((v) => v.type === "horas_extra_semanales_excedidas")).toBe(false);
  });
});

describe("validateTurnosLft: descanso semanal incumplido (Art. 69)", () => {
  it("7 días consecutivos de trabajo sin descanso se rechaza citando el art. 69", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED, THU, FRI, SAT, SUN].map((d) =>
      shift("camarista-1", d, "08:00", "14:00"),
    );
    const result = validateTurnosLft({ shifts });
    const v = result.violations.find((x) => x.type === "descanso_semanal_incumplido");
    expect(v).toBeDefined();
    expect(v?.article).toBe("LFT art. 69");
    expect(v?.scope).toMatchObject({ rangeStart: MON, rangeEnd: SUN });
  });

  it("6 días consecutivos de trabajo (el máximo permitido) NO viola el descanso", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED, THU, FRI, SAT].map((d) => shift("camarista-1", d, "08:00", "14:00"));
    const result = validateTurnosLft({ shifts });
    expect(result.violations.some((v) => v.type === "descanso_semanal_incumplido")).toBe(false);
  });

  it("una racha de 7 días que cruza el límite de dos semanas ISO también se detecta", () => {
    // Jueves de la semana 1 a miércoles de la semana 2 = 7 días consecutivos, cruzando
    // el corte lunes-domingo (THU=10-sep .. WED=16-sep).
    const crossing: ProposedShift[] = [
      "2026-09-10", // jueves semana 1
      "2026-09-11",
      "2026-09-12",
      "2026-09-13", // domingo semana 1
      "2026-09-14", // lunes semana 2
      "2026-09-15",
      "2026-09-16", // 7º día consecutivo
    ].map((d) => shift("camarista-1", d, "08:00", "14:00"));
    const result = validateTurnosLft({ shifts: crossing });
    expect(result.violations.some((v) => v.type === "descanso_semanal_incumplido")).toBe(true);
  });
});

describe("validateTurnosLft: jornada semanal ordinaria y transición a 40h (Art. 61)", () => {
  it("6 días de 8h = 48h/semana, exactamente en el límite vigente: no viola", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED, THU, FRI, SAT].map((d) => shift("camarista-1", d, "08:00", "16:00"));
    const result = validateTurnosLft({ shifts });
    expect(result.violations.some((v) => v.type === "jornada_semanal_ordinaria_excedida")).toBe(false);
  });

  it("con el régimen de transición a 40h ya vigente para esa semana, 48h ordinarias sí violan", () => {
    const shifts: ProposedShift[] = [MON, TUE, WED, THU, FRI, SAT].map((d) => shift("camarista-1", d, "08:00", "16:00"));
    const transitionSchedule: WeeklyHourLimitMilestone[] = [
      { effectiveFrom: "1970-01-01", maxOrdinaryWeeklyHours: 48 },
      { effectiveFrom: "2026-01-01", maxOrdinaryWeeklyHours: 40 },
    ];
    const result = validateTurnosLft({ shifts, weeklyHourLimitSchedule: transitionSchedule });
    const v = result.violations.find((x) => x.type === "jornada_semanal_ordinaria_excedida");
    expect(v).toBeDefined();
    expect(v?.article).toContain("2026-01-01");
    expect(v?.article).toContain("40h/semana");
  });

  it("una semana ANTERIOR al hito de transición sigue evaluándose contra 48h", () => {
    const pastWeekShifts: ProposedShift[] = ["2025-01-05", "2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10"].map(
      (d) => shift("camarista-1", d, "08:00", "16:00"),
    );
    const transitionSchedule: WeeklyHourLimitMilestone[] = [
      { effectiveFrom: "1970-01-01", maxOrdinaryWeeklyHours: 48 },
      { effectiveFrom: "2026-01-01", maxOrdinaryWeeklyHours: 40 },
    ];
    const result = validateTurnosLft({ shifts: pastWeekShifts, weeklyHourLimitSchedule: transitionSchedule });
    expect(result.violations.some((v) => v.type === "jornada_semanal_ordinaria_excedida")).toBe(false);
  });
});

describe("validateTurnosLft: múltiples camaristas se evalúan de forma independiente", () => {
  it("una camarista con plantilla ilegal no contamina el resultado de otra con plantilla legal", () => {
    const shifts: ProposedShift[] = [
      ...[MON, TUE, WED].map((d) => shift("camarista-legal", d, "08:00", "16:00")),
      shift("camarista-ilegal", MON, "08:00", "22:00"),
    ];
    const result = validateTurnosLft({ shifts });
    expect(result.valid).toBe(false);
    expect(result.violations.every((v) => v.staffId === "camarista-ilegal")).toBe(true);
  });
});
