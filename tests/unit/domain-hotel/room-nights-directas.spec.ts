// REQ-OBS-008: % de room-nights generadas directamente por el agente de IA, como
// métrica de producto. Usa `origin_actor` hipotéticos para probar el CÁLCULO -- ver el
// header de `atribucionOrigenAgentico.ts` sobre por qué esto no simula datos falsos en
// producción (hoy solo 'manual' existe de verdad, ver migración 0130).
import { describe, expect, it } from "vitest";
import {
  AGENTIC_ORIGIN_ACTOR,
  MANUAL_ORIGIN_ACTOR,
  buildAgenticOriginReport,
  isAgenticOrigin,
  type ReservationOriginInput,
} from "@atiende-hoteles/domain-hotel";

describe("isAgenticOrigin", () => {
  it("solo 'agente_ia' es agéntico", () => {
    expect(isAgenticOrigin(AGENTIC_ORIGIN_ACTOR)).toBe(true);
    expect(isAgenticOrigin(MANUAL_ORIGIN_ACTOR)).toBe(false);
    expect(isAgenticOrigin("cualquier_otro")).toBe(false);
  });
});

describe("buildAgenticOriginReport (REQ-OBS-008)", () => {
  it("con solo reservas manuales, 0% de room-nights son agénticas", () => {
    const reservations: ReservationOriginInput[] = [
      { id: "r1", originActor: "manual", nights: 3 },
      { id: "r2", originActor: "manual", nights: 2 },
    ];
    const report = buildAgenticOriginReport(reservations);
    expect(report.totalReservations).toBe(2);
    expect(report.totalRoomNights).toBe(5);
    expect(report.agenticRoomNights).toBe(0);
    expect(report.agenticRoomNightsPct).toBe(0);
    expect(report.origins).toEqual([{ originActor: "manual", reservationCount: 2, roomNights: 5 }]);
  });

  it("mezcla manual/agéntico: reproduce EXACTAMENTE el % esperado sobre un dataset sintético", () => {
    // Dataset sintético controlado: 4 noches agénticas de 10 totales -> 40% exacto,
    // el mismo criterio de "reproducción exacta del porcentaje" que exige
    // docs/ACEPTACION.md para este REQ.
    const reservations: ReservationOriginInput[] = [
      { id: "r1", originActor: "agente_ia", nights: 4 },
      { id: "r2", originActor: "manual", nights: 6 },
    ];
    const report = buildAgenticOriginReport(reservations);
    expect(report.totalRoomNights).toBe(10);
    expect(report.agenticRoomNights).toBe(4);
    expect(report.agenticRoomNightsPct).toBe(40);

    const agentico = report.origins.find((o) => o.originActor === "agente_ia")!;
    expect(agentico.reservationCount).toBe(1);
    expect(agentico.roomNights).toBe(4);
  });

  it("100% agéntico cuando todas las reservas del periodo son del agente", () => {
    const reservations: ReservationOriginInput[] = [{ id: "r1", originActor: "agente_ia", nights: 7 }];
    const report = buildAgenticOriginReport(reservations);
    expect(report.agenticRoomNightsPct).toBe(100);
  });

  it("sin reservas: reporte vacío consistente, agenticRoomNightsPct es 0 (no NaN)", () => {
    const report = buildAgenticOriginReport([]);
    expect(report.totalReservations).toBe(0);
    expect(report.totalRoomNights).toBe(0);
    expect(report.agenticRoomNights).toBe(0);
    expect(report.agenticRoomNightsPct).toBe(0);
    expect(report.origins).toEqual([]);
  });

  it("un tercer valor de origin_actor no reconocido no cuenta como agéntico (fail-closed) pero sí suma al total", () => {
    const reservations: ReservationOriginInput[] = [
      { id: "r1", originActor: "valor_desconocido", nights: 5 },
      { id: "r2", originActor: "agente_ia", nights: 5 },
    ];
    const report = buildAgenticOriginReport(reservations);
    expect(report.totalRoomNights).toBe(10);
    expect(report.agenticRoomNights).toBe(5);
    expect(report.agenticRoomNightsPct).toBe(50);
  });

  it("los actores del reporte se ordenan alfabéticamente (salida determinista)", () => {
    const reservations: ReservationOriginInput[] = [
      { id: "r1", originActor: "manual", nights: 1 },
      { id: "r2", originActor: "agente_ia", nights: 1 },
    ];
    const report = buildAgenticOriginReport(reservations);
    expect(report.origins.map((o) => o.originActor)).toEqual(["agente_ia", "manual"]);
  });
});
