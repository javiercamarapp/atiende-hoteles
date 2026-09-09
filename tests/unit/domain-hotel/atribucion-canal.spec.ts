// REQ-RES-020: atribución de comisión y reporting de room-nights directas por canal.
// Usa canales hipotéticos ('ota_ejemplo', 'agente_ia_externo') para probar el CÁLCULO
// -- ver el header de atribucionCanal.ts sobre por qué esto no simula datos falsos en
// producción (hoy solo 'directo' existe de verdad).
import { describe, expect, it } from "vitest";
import {
  DIRECT_CHANNEL,
  assertValidChannelCommissionConfig,
  buildChannelAttributionReport,
  isDirectChannel,
  resolveCommissionPct,
  type ChannelCommissionConfig,
  type ReservationAttributionInput,
} from "@atiende-hoteles/domain-hotel";

describe("isDirectChannel", () => {
  it("solo 'directo' es directo", () => {
    expect(isDirectChannel("directo")).toBe(true);
    expect(isDirectChannel("ota_ejemplo")).toBe(false);
    expect(isDirectChannel("")).toBe(false);
  });
});

describe("resolveCommissionPct (REQ-RES-020)", () => {
  const configs: ChannelCommissionConfig[] = [{ channel: "ota_ejemplo", commissionPct: 18 }];

  it("'directo' siempre resuelve a 0% sin importar la config", () => {
    expect(resolveCommissionPct(DIRECT_CHANNEL, configs)).toBe(0);
    expect(resolveCommissionPct(DIRECT_CHANNEL, [{ channel: "directo", commissionPct: 99 } as ChannelCommissionConfig])).toBe(0);
  });

  it("un canal configurado usa su commissionPct", () => {
    expect(resolveCommissionPct("ota_ejemplo", configs)).toBe(18);
  });

  it("fail-closed: un canal SIN config resuelve a 0% (nunca inventa una comisión)", () => {
    expect(resolveCommissionPct("agente_ia_externo", configs)).toBe(0);
  });
});

describe("assertValidChannelCommissionConfig", () => {
  it("rechaza 'directo' (nunca se configura)", () => {
    expect(() => assertValidChannelCommissionConfig({ channel: "directo", commissionPct: 10 })).toThrow(/canal_invalido/);
  });
  it("rechaza canal vacío", () => {
    expect(() => assertValidChannelCommissionConfig({ channel: "   ", commissionPct: 10 })).toThrow(/canal_invalido/);
  });
  it("rechaza commissionPct fuera de [0,100]", () => {
    expect(() => assertValidChannelCommissionConfig({ channel: "ota_ejemplo", commissionPct: 150 })).toThrow(/comision_invalida/);
    expect(() => assertValidChannelCommissionConfig({ channel: "ota_ejemplo", commissionPct: -1 })).toThrow(/comision_invalida/);
  });
  it("acepta una config válida sin lanzar", () => {
    expect(() => assertValidChannelCommissionConfig({ channel: "ota_ejemplo", commissionPct: 18 })).not.toThrow();
  });
});

describe("buildChannelAttributionReport (REQ-RES-020)", () => {
  const configs: ChannelCommissionConfig[] = [{ channel: "ota_ejemplo", commissionPct: 20 }];

  it("con solo reservas directas, 100% de room-nights son directas y comisión total es 0", () => {
    const reservations: ReservationAttributionInput[] = [
      { id: "r1", channel: "directo", nights: 3, netAmount: 3000 },
      { id: "r2", channel: "directo", nights: 2, netAmount: 2000 },
    ];
    const report = buildChannelAttributionReport(reservations, configs);
    expect(report.totalReservations).toBe(2);
    expect(report.totalRoomNights).toBe(5);
    expect(report.directRoomNights).toBe(5);
    expect(report.directRoomNightsPct).toBe(100);
    expect(report.totalCommissionAmount).toBe(0);
    expect(report.channels).toEqual([
      {
        channel: "directo",
        reservationCount: 2,
        roomNights: 5,
        netRevenue: 5000,
        commissionPct: 0,
        commissionAmount: 0,
        netRevenueAfterCommission: 5000,
      },
    ]);
  });

  it("mezcla directo/OTA: agrega por canal, calcula comisión solo del canal configurado y el % de room-nights directas correcto", () => {
    const reservations: ReservationAttributionInput[] = [
      { id: "r1", channel: "directo", nights: 4, netAmount: 4000 },
      { id: "r2", channel: "ota_ejemplo", nights: 6, netAmount: 6000 },
    ];
    const report = buildChannelAttributionReport(reservations, configs);
    expect(report.totalRoomNights).toBe(10);
    expect(report.directRoomNights).toBe(4);
    expect(report.directRoomNightsPct).toBe(40);

    const ota = report.channels.find((c) => c.channel === "ota_ejemplo")!;
    expect(ota.netRevenue).toBe(6000);
    expect(ota.commissionPct).toBe(20);
    expect(ota.commissionAmount).toBe(1200); // 20% de 6000
    expect(ota.netRevenueAfterCommission).toBe(4800);

    const directo = report.channels.find((c) => c.channel === "directo")!;
    expect(directo.commissionAmount).toBe(0);

    expect(report.totalCommissionAmount).toBe(1200);
  });

  it("sin reservas: reporte vacío consistente, directRoomNightsPct es 0 (no NaN)", () => {
    const report = buildChannelAttributionReport([], configs);
    expect(report.totalReservations).toBe(0);
    expect(report.totalRoomNights).toBe(0);
    expect(report.directRoomNights).toBe(0);
    expect(report.directRoomNightsPct).toBe(0);
    expect(report.totalCommissionAmount).toBe(0);
    expect(report.channels).toEqual([]);
  });

  it("un canal sin fila de configuración reporta commissionAmount 0 (fail-closed)", () => {
    const reservations: ReservationAttributionInput[] = [{ id: "r1", channel: "agente_ia_externo", nights: 2, netAmount: 2000 }];
    const report = buildChannelAttributionReport(reservations, configs);
    const canal = report.channels[0]!;
    expect(canal.commissionPct).toBe(0);
    expect(canal.commissionAmount).toBe(0);
  });

  it("los canales del reporte se ordenan alfabéticamente (salida determinista)", () => {
    const reservations: ReservationAttributionInput[] = [
      { id: "r1", channel: "z_canal", nights: 1, netAmount: 100 },
      { id: "r2", channel: "a_canal", nights: 1, netAmount: 100 },
    ];
    const report = buildChannelAttributionReport(reservations, []);
    expect(report.channels.map((c) => c.channel)).toEqual(["a_canal", "z_canal"]);
  });
});
