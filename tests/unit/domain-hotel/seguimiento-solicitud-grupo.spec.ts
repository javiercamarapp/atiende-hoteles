// REQ-RES-013 (docs/ACEPTACION.md): "Solicitud de grupo sin respuesta recibe
// seguimiento automático a las 48h y a los 7 días; ninguna propuesta de RFP sale sin un
// registro de validación humana previa (0 propuestas sin ese registro)." Unit puro (sin
// BD, sin reloj real) de
// `packages/domain-hotel/src/reservas/seguimientoSolicitudGrupo.ts` -- verifica: (1) el
// cómputo exacto de las 2 ventanas (48h/7 días) desde la creación, (2) la detección de
// vencimiento con un reloj INYECTADO, incluyendo el caso límite exacto y el caso "ya
// ejecutado" (nunca vuelve a calificar), y (3) el gate de validación humana previa a una
// propuesta de RFP (sin validación, de otra solicitud, y posterior al envío -- los 3
// casos que el trigger de Postgres `propuesta_rfp_guard`, 0130, también rechaza; el
// escenario end-to-end contra embedded-postgres real vive en
// `tests/integration/grupos/seguimiento.spec.ts` y el adversarial de bypass directo en
// `tests/adversarial/propuesta-rfp-sin-validacion.spec.ts`).
import { describe, expect, it } from "vitest";
import {
  GROUP_FOLLOW_UP_TYPES,
  GROUP_FOLLOW_UP_WINDOW_HOURS,
  computeGroupFollowUpSchedule,
  isGroupFollowUpDue,
  selectDueGroupFollowUps,
  assertHumanValidationBeforeProposal,
  PropuestaRfpSinValidacionError,
  type PendingGroupFollowUp,
} from "@atiende-hoteles/domain-hotel";

describe("computeGroupFollowUpSchedule (REQ-RES-013: 48h y 7 días exactos)", () => {
  it("calcula exactamente 2 seguimientos, en 48h y 7 días desde la creación", () => {
    const creadaEn = new Date("2026-01-01T10:00:00.000Z");
    const schedule = computeGroupFollowUpSchedule(creadaEn);

    expect(schedule.map((s) => s.tipo)).toEqual([...GROUP_FOLLOW_UP_TYPES]);
    expect(schedule.find((s) => s.tipo === "48h")!.programadoPara.toISOString()).toBe("2026-01-03T10:00:00.000Z");
    expect(schedule.find((s) => s.tipo === "7d")!.programadoPara.toISOString()).toBe("2026-01-08T10:00:00.000Z");
  });

  it("las ventanas son literales del criterio de aceptación (48 y 168 horas), no configurables por hotel", () => {
    expect(GROUP_FOLLOW_UP_WINDOW_HOURS["48h"]).toBe(48);
    expect(GROUP_FOLLOW_UP_WINDOW_HOURS["7d"]).toBe(24 * 7);
  });
});

describe("isGroupFollowUpDue / selectDueGroupFollowUps — reloj inyectado, nunca Date.now() interno", () => {
  const programadoPara = new Date("2026-01-03T10:00:00.000Z");

  it("no vencido un instante antes de la hora programada", () => {
    const antes = new Date(programadoPara.getTime() - 1);
    expect(isGroupFollowUpDue(antes, { programadoPara, ejecutadoEn: null })).toBe(false);
  });

  it("vencido EXACTAMENTE en la hora programada (caso límite, >=)", () => {
    expect(isGroupFollowUpDue(programadoPara, { programadoPara, ejecutadoEn: null })).toBe(true);
  });

  it("vencido después de la hora programada", () => {
    const despues = new Date(programadoPara.getTime() + 60_000);
    expect(isGroupFollowUpDue(despues, { programadoPara, ejecutadoEn: null })).toBe(true);
  });

  it("un seguimiento YA ejecutado nunca vuelve a calificar, sin importar cuánto avance el reloj", () => {
    const muchoDespues = new Date(programadoPara.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(isGroupFollowUpDue(muchoDespues, { programadoPara, ejecutadoEn: new Date("2026-01-03T10:00:01.000Z") })).toBe(
      false,
    );
  });

  it("selectDueGroupFollowUps filtra solo los vencidos y no ejecutados, preservando el resto de la forma del objeto", () => {
    const candidatos: PendingGroupFollowUp[] = [
      { id: "a", tipo: "48h", programadoPara: new Date("2026-01-03T10:00:00.000Z"), ejecutadoEn: null },
      { id: "b", tipo: "7d", programadoPara: new Date("2026-01-08T10:00:00.000Z"), ejecutadoEn: null },
      { id: "c", tipo: "48h", programadoPara: new Date("2026-01-02T00:00:00.000Z"), ejecutadoEn: new Date("2026-01-02T00:00:01.000Z") },
    ];
    const now = new Date("2026-01-04T00:00:00.000Z");
    const due = selectDueGroupFollowUps(now, candidatos);
    expect(due.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("assertHumanValidationBeforeProposal — gate de aplicación (REQ-RES-013: 0 propuestas sin ese registro)", () => {
  const solicitudId = "11111111-1111-1111-1111-111111111111";
  const now = new Date("2026-01-10T12:00:00.000Z");

  it("rechaza cuando no existe ningún registro de validación", () => {
    expect(() => assertHumanValidationBeforeProposal(solicitudId, null, now)).toThrow(PropuestaRfpSinValidacionError);
  });

  it("rechaza una validación que pertenece a OTRA solicitud", () => {
    const validacion = { id: "v1", solicitudId: "22222222-2222-2222-2222-222222222222", validadoEn: new Date("2026-01-09T00:00:00.000Z") };
    expect(() => assertHumanValidationBeforeProposal(solicitudId, validacion, now)).toThrow(PropuestaRfpSinValidacionError);
  });

  it("rechaza una validación fechada DESPUÉS del envío (no es previa)", () => {
    const validacion = { id: "v1", solicitudId, validadoEn: new Date("2026-01-11T00:00:00.000Z") };
    expect(() => assertHumanValidationBeforeProposal(solicitudId, validacion, now)).toThrow(PropuestaRfpSinValidacionError);
  });

  it("acepta una validación previa de la MISMA solicitud", () => {
    const validacion = { id: "v1", solicitudId, validadoEn: new Date("2026-01-09T00:00:00.000Z") };
    expect(() => assertHumanValidationBeforeProposal(solicitudId, validacion, now)).not.toThrow();
  });

  it("acepta una validación fechada en el MISMO instante del envío (previa o simultánea, nunca posterior)", () => {
    const validacion = { id: "v1", solicitudId, validadoEn: now };
    expect(() => assertHumanValidationBeforeProposal(solicitudId, validacion, now)).not.toThrow();
  });
});
