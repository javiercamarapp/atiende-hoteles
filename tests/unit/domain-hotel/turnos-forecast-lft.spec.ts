// REQ-BO-020 (P1/F): "el sistema debe generar horarios de turnos a partir de un pronóstico
// de ocupación/demanda del PMS por día y puesto, respetando LFT (jornada, descanso, prima
// dominical, reforma de 40h), y reducir horas extra vs. baseline manual." Esta es la mitad
// GENERADORA que faltaba junto a `turnos-lft.spec.ts` (REQ-HK-008, la mitad validadora de
// una plantilla YA propuesta). Cruce puro (sin Postgres), mismo criterio que
// tests/unit/domain-hotel/turnos-lft.spec.ts.
import { describe, expect, it } from "vitest";
import {
  assertTurnosLftPublishable,
  compareOvertimeVsBaseline,
  generateTurnosFromForecast,
  validateTurnosLft,
  type AvailableStaffMember,
  type ManualBaselineShift,
  type StaffingDemandEntry,
  type WeeklyHourLimitMilestone,
} from "@atiende-hoteles/domain-hotel";

/** Lunes 2026-09-07 .. domingo 2026-09-13 (semana ISO completa), igual que
 *  turnos-lft.spec.ts, para no depender de en qué día del año caiga "hoy". */
const MON = "2026-09-07";
const TUE = "2026-09-08";
const WED = "2026-09-09";
const THU = "2026-09-10";
const FRI = "2026-09-11";
const SAT = "2026-09-12";
const SUN = "2026-09-13";
const MON2 = "2026-09-14";

const HK_SHIFT = { startTime: "08:00", endTime: "16:00" }; // 8h diurna, exacto al límite ordinario art. 61

function staff(staffId: string, position: string, opts?: Partial<AvailableStaffMember>): AvailableStaffMember {
  return { staffId, position, standardShift: HK_SHIFT, ...opts };
}

function demand(workDate: string, position: string, requiredHeadcount: number): StaffingDemandEntry {
  return { workDate, position, requiredHeadcount };
}

describe("generateTurnosFromForecast: cobertura básica desde demanda pronosticada", () => {
  it("cubre toda la demanda repartiendo entre el pool cuando alcanza el personal", () => {
    const result = generateTurnosFromForecast({
      demand: [MON, TUE, WED, THU, FRI].map((d) => demand(d, "housekeeping", 2)),
      staffPool: [staff("hk-1", "housekeeping"), staff("hk-2", "housekeeping"), staff("hk-3", "housekeeping")],
    });

    expect(result.unmetDemand).toEqual([]);
    expect(result.shifts).toHaveLength(10); // 5 días x 2 headcount
    expect(validateTurnosLft({ shifts: result.shifts }).valid).toBe(true);
    expect(() => assertTurnosLftPublishable({ shifts: result.shifts })).not.toThrow();

    // Cada día tiene exactamente 2 personas distintas cubriendo, y las 3 personas del pool
    // se usan a lo largo de la semana (reparto de carga, no concentración en 2 de 3).
    const staffIdsByDay = new Map<string, Set<string>>();
    for (const shift of result.shifts) {
      const set = staffIdsByDay.get(shift.workDate) ?? new Set<string>();
      set.add(shift.staffId);
      staffIdsByDay.set(shift.workDate, set);
    }
    for (const set of staffIdsByDay.values()) expect(set.size).toBe(2);
    const allStaffIdsUsed = new Set(result.shifts.map((s) => s.staffId));
    expect(allStaffIdsUsed.size).toBe(3);
  });

  it("no genera ni un solo turno cuando requiredHeadcount es 0 ese día/puesto", () => {
    const result = generateTurnosFromForecast({
      demand: [demand(MON, "housekeeping", 0)],
      staffPool: [staff("hk-1", "housekeeping")],
    });
    expect(result.shifts).toEqual([]);
    expect(result.unmetDemand).toEqual([]);
  });

  it("respeta unavailableDates: si el único candidato no está disponible, reporta demanda no cubierta", () => {
    const result = generateTurnosFromForecast({
      demand: [demand(MON, "housekeeping", 1)],
      staffPool: [staff("hk-1", "housekeeping", { unavailableDates: [MON] })],
    });
    expect(result.shifts).toEqual([]);
    expect(result.unmetDemand).toEqual([
      {
        workDate: MON,
        position: "housekeeping",
        requiredHeadcount: 1,
        coveredHeadcount: 0,
        shortfall: 1,
        reason: expect.stringContaining("sin personal disponible"),
      },
    ]);
  });

  it("no mezcla puestos: un frontdesk no cubre demanda de housekeeping aunque sobre personal", () => {
    const result = generateTurnosFromForecast({
      demand: [demand(MON, "housekeeping", 1)],
      staffPool: [staff("fd-1", "frontdesk")],
    });
    expect(result.shifts).toEqual([]);
    expect(result.unmetDemand[0]?.reason).toContain('sin personal disponible del puesto "housekeeping"');
  });

  it("declara prima dominical (art. 71) solo en los turnos que caen en domingo", () => {
    const result = generateTurnosFromForecast({
      demand: [demand(SAT, "housekeeping", 1), demand(SUN, "housekeeping", 1)],
      staffPool: [staff("hk-1", "housekeeping"), staff("hk-2", "housekeeping")],
    });
    const satShift = result.shifts.find((s) => s.workDate === SAT);
    const sunShift = result.shifts.find((s) => s.workDate === SUN);
    expect(satShift?.sundayPremiumApplies).toBe(false);
    expect(sunShift?.sundayPremiumApplies).toBe(true);
  });
});

describe("generateTurnosFromForecast: caso que violaría LFT → rechazado", () => {
  it("nunca asigna el 7º día consecutivo a un colaborador (art. 69): lo reporta como demanda no cubierta, no lo publica", () => {
    const staffId = "hk-solo";
    const eightConsecutiveDays = [MON, TUE, WED, THU, FRI, SAT, SUN, MON2];
    const result = generateTurnosFromForecast({
      demand: eightConsecutiveDays.map((d) => demand(d, "housekeeping", 1)),
      staffPool: [staff(staffId, "housekeeping")],
    });

    // El domingo (7º día consecutivo si se asignara) NO debe aparecer entre los turnos
    // generados -- ese es el "rechazado" del criterio de aceptación.
    expect(result.shifts.some((s) => s.workDate === SUN)).toBe(false);
    // Los otros 7 días sí se cubren (el domingo es el único que rompería la LFT).
    expect(result.shifts.map((s) => s.workDate).sort()).toEqual(
      [MON, TUE, WED, THU, FRI, SAT, MON2].sort(),
    );

    // La demanda no cubierta queda declarada explícitamente, citando la violación real.
    const unmetSunday = result.unmetDemand.find((u) => u.workDate === SUN);
    expect(unmetSunday).toBeDefined();
    expect(unmetSunday?.shortfall).toBe(1);
    expect(unmetSunday?.reason).toContain("LFT");

    // Y la plantilla que SÍ se produjo es, por construcción, publicable: nunca viola la LFT.
    const check = validateTurnosLft({ shifts: result.shifts });
    expect(check.valid).toBe(true);
    expect(() => assertTurnosLftPublishable({ shifts: result.shifts })).not.toThrow();
  });

  it("respeta un régimen semanal reducido (transición a 40h) pasado explícitamente", () => {
    const staffId = "hk-solo";
    const sixDays = [MON, TUE, WED, THU, FRI, SAT]; // 6 x 8h = 48h: al límite vigente hoy, por encima del régimen de 40h
    const schedule40h: WeeklyHourLimitMilestone[] = [{ effectiveFrom: "1970-01-01", maxOrdinaryWeeklyHours: 40 }];

    const under48h = generateTurnosFromForecast({
      demand: sixDays.map((d) => demand(d, "housekeeping", 1)),
      staffPool: [staff(staffId, "housekeeping")],
    });
    // Bajo el régimen vigente (48h), 6 días x 8h = 48h exactas: sí se cubren los 6 días.
    expect(under48h.unmetDemand).toEqual([]);
    expect(under48h.shifts).toHaveLength(6);

    const under40h = generateTurnosFromForecast({
      demand: sixDays.map((d) => demand(d, "housekeeping", 1)),
      staffPool: [staff(staffId, "housekeeping")],
      weeklyHourLimitSchedule: schedule40h,
    });
    // Bajo transición a 40h, el sexto día (2880min > 2400min) ya no cabe: queda sin cubrir
    // en vez de publicarse una plantilla que exceda el nuevo límite semanal.
    expect(under40h.unmetDemand.length).toBeGreaterThan(0);
    expect(under40h.shifts.length).toBeLessThan(6);
    expect(validateTurnosLft({ shifts: under40h.shifts, weeklyHourLimitSchedule: schedule40h }).valid).toBe(true);
  });

  it("valida datos estructuralmente inválidos antes de intentar generar (RangeError, no una violación legal silenciosa)", () => {
    expect(() =>
      generateTurnosFromForecast({ demand: [demand("2026-9-7", "housekeeping", 1)], staffPool: [] }),
    ).toThrow(RangeError);
    expect(() =>
      generateTurnosFromForecast({ demand: [demand(MON, "housekeeping", -1)], staffPool: [] }),
    ).toThrow(RangeError);
    expect(() => generateTurnosFromForecast({ demand: [demand(MON, "", 1)], staffPool: [] })).toThrow(RangeError);
  });
});

describe("compareOvertimeVsBaseline / generateTurnosFromForecast: reducción de horas extra vs. baseline manual medida", () => {
  it("el horario generado reparte carga y mide una reducción real de horas extra frente a un baseline manual concentrado", () => {
    const days = [MON, TUE, WED, THU, FRI];

    // Baseline manual típico: una sola persona de confianza cubre toda la semana con
    // turnos de 11h (3h de tiempo extra/día sobre las 8h ordinarias de jornada diurna).
    const manualBaseline: ManualBaselineShift[] = days.map((d) => ({
      staffId: "hk-mgr",
      workDate: d,
      startTime: "07:00",
      endTime: "18:00", // 11h
    }));

    const result = generateTurnosFromForecast({
      demand: days.map((d) => demand(d, "housekeeping", 2)),
      staffPool: [staff("hk-1", "housekeeping"), staff("hk-2", "housekeeping"), staff("hk-3", "housekeeping")],
      manualBaseline,
    });

    expect(result.overtimeComparison).not.toBeNull();
    const cmp = result.overtimeComparison!;
    expect(cmp.baselineOvertimeMinutes).toBe(5 * 3 * 60); // 15h de tiempo extra en el baseline manual
    expect(cmp.generatedOvertimeMinutes).toBe(0); // turnos de 8h exactos, sin tiempo extra
    expect(cmp.reductionMinutes).toBe(5 * 3 * 60);
    expect(cmp.reductionPct).toBe(100);
    expect(cmp.baselineHadNoOvertime).toBe(false);
  });

  it("sin manualBaseline no se produce comparación (no se inventa una reducción sin referencia)", () => {
    const result = generateTurnosFromForecast({
      demand: [demand(MON, "housekeeping", 1)],
      staffPool: [staff("hk-1", "housekeeping")],
    });
    expect(result.overtimeComparison).toBeNull();
  });

  it("compareOvertimeVsBaseline: baseline sin horas extra no reporta una reducción falsa", () => {
    const cmp = compareOvertimeVsBaseline(
      [{ staffId: "hk-1", workDate: MON, startTime: "08:00", endTime: "16:00" }],
      [{ staffId: "hk-1", workDate: MON, startTime: "08:00", endTime: "16:00" }],
    );
    expect(cmp.baselineOvertimeMinutes).toBe(0);
    expect(cmp.generatedOvertimeMinutes).toBe(0);
    expect(cmp.baselineHadNoOvertime).toBe(true);
    expect(cmp.reductionPct).toBe(0);
  });
});
