// REQ-REV-006 (P1/F, fuentes BP-087/H02-001/H05-003): "el sistema debe decidir/ejecutar
// el mix de canal (cerrar OTA en fechas de alta demanda, pausar campañas de metasearch
// al superar umbral de ocupación proyectada, subir puja) registrando la razón de cada
// decisión." Espejo puro (sin BD) de esta lógica -- mismo criterio que
// tests/unit/domain-hotel/parity-guard.spec.ts frente a tests/integration/revenue/
// parity-guard.spec.ts. La prueba de integración real (tests/integration/revenue/
// mix-canal.spec.ts) complementa esta con el espejo de esquema real en Postgres.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_MIX_ACTIONS,
  CHANNEL_TYPES,
  ChannelMixEngineError,
  assertValidChannelMixChannelConfig,
  assertValidStayDate,
  evaluateChannelMix,
  evaluateChannelMixDecision,
  type ChannelMixChannelConfig,
} from "@atiende-hoteles/domain-hotel";

function otaConfig(overrides: Partial<ChannelMixChannelConfig> = {}): ChannelMixChannelConfig {
  return {
    channel: "booking.com",
    channelType: "ota",
    highDemandOccupancyThresholdPct: 90,
    isOpen: true,
    ...overrides,
  };
}

function metasearchConfig(overrides: Partial<ChannelMixChannelConfig> = {}): ChannelMixChannelConfig {
  return {
    channel: "google_hotel_ads",
    channelType: "metasearch",
    pauseOccupancyThresholdPct: 85,
    raiseBidOccupancyThresholdPct: 40,
    bidRaisePct: 15,
    isActive: true,
    ...overrides,
  };
}

describe("catálogos", () => {
  it("expone exactamente los 2 tipos de canal y las 3 acciones del requisito", () => {
    expect(CHANNEL_TYPES).toEqual(["ota", "metasearch"]);
    expect(CHANNEL_MIX_ACTIONS).toEqual(["cerrar_ota", "pausar_metasearch", "subir_puja"]);
  });
});

describe("assertValidStayDate", () => {
  it("acepta una fecha de calendario válida", () => {
    expect(() => assertValidStayDate("2026-12-24")).not.toThrow();
  });

  it("rechaza formato inválido", () => {
    expect(() => assertValidStayDate("24-12-2026")).toThrow(/fecha_invalida/);
    expect(() => assertValidStayDate("2026-12-24T00:00:00Z")).toThrow(/fecha_invalida/);
  });

  it("rechaza fecha de calendario imposible (31 de febrero, etc.)", () => {
    expect(() => assertValidStayDate("2026-02-30")).toThrow(/fecha_invalida/);
    expect(() => assertValidStayDate("2026-13-01")).toThrow(/fecha_invalida/);
  });
});

describe("assertValidChannelMixChannelConfig", () => {
  it("acepta un canal OTA válido y un canal metasearch válido sin lanzar", () => {
    expect(() => assertValidChannelMixChannelConfig(otaConfig())).not.toThrow();
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig())).not.toThrow();
  });

  it("rechaza nombre de canal vacío", () => {
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ channel: "" }))).toThrow(/canal_faltante/);
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ channel: "   " }))).toThrow(/canal_faltante/);
  });

  it("rechaza channelType fuera del catálogo", () => {
    expect(() => assertValidChannelMixChannelConfig({ ...otaConfig(), channelType: "directo" as never })).toThrow(/tipo_canal_invalido/);
  });

  it("un canal OTA rechaza campos de metasearch declarados", () => {
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ isActive: true } as never))).toThrow(/campos_metasearch_en_canal_ota/);
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ bidRaisePct: 10 } as never))).toThrow(/campos_metasearch_en_canal_ota/);
  });

  it("un canal OTA exige highDemandOccupancyThresholdPct en (0, 100]", () => {
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ highDemandOccupancyThresholdPct: 0 }))).toThrow(/umbral_alta_demanda_invalido/);
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ highDemandOccupancyThresholdPct: 101 }))).toThrow(/umbral_alta_demanda_invalido/);
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ highDemandOccupancyThresholdPct: Number.NaN }))).toThrow(
      /umbral_alta_demanda_invalido/,
    );
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ highDemandOccupancyThresholdPct: 100 }))).not.toThrow();
  });

  it("un canal OTA exige isOpen booleano", () => {
    expect(() => assertValidChannelMixChannelConfig(otaConfig({ isOpen: undefined }))).toThrow(/estado_ota_faltante/);
  });

  it("un canal metasearch rechaza campos de OTA declarados", () => {
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ isOpen: true } as never))).toThrow(/campos_ota_en_canal_metasearch/);
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ highDemandOccupancyThresholdPct: 90 } as never))).toThrow(
      /campos_ota_en_canal_metasearch/,
    );
  });

  it("un canal metasearch exige pauseOccupancyThresholdPct en (0, 100]", () => {
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ pauseOccupancyThresholdPct: 0 }))).toThrow(/umbral_pausa_invalido/);
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ pauseOccupancyThresholdPct: 101 }))).toThrow(/umbral_pausa_invalido/);
  });

  it("un canal metasearch exige raiseBidOccupancyThresholdPct en [0, 100)", () => {
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ raiseBidOccupancyThresholdPct: -1 }))).toThrow(/umbral_puja_invalido/);
    expect(() =>
      assertValidChannelMixChannelConfig(metasearchConfig({ raiseBidOccupancyThresholdPct: 40, pauseOccupancyThresholdPct: 100 })),
    ).not.toThrow();
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ raiseBidOccupancyThresholdPct: 0 }))).not.toThrow();
  });

  it("rechaza bandas de pausa/puja solapadas o invertidas", () => {
    expect(() =>
      assertValidChannelMixChannelConfig(metasearchConfig({ pauseOccupancyThresholdPct: 50, raiseBidOccupancyThresholdPct: 50 })),
    ).toThrow(/bandas_solapadas/);
    expect(() =>
      assertValidChannelMixChannelConfig(metasearchConfig({ pauseOccupancyThresholdPct: 40, raiseBidOccupancyThresholdPct: 60 })),
    ).toThrow(/bandas_solapadas/);
  });

  it("un canal metasearch exige bidRaisePct positivo", () => {
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ bidRaisePct: 0 }))).toThrow(/alza_puja_invalida/);
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ bidRaisePct: -5 }))).toThrow(/alza_puja_invalida/);
  });

  it("un canal metasearch exige isActive booleano", () => {
    expect(() => assertValidChannelMixChannelConfig(metasearchConfig({ isActive: undefined }))).toThrow(/estado_metasearch_faltante/);
  });
});

describe("evaluateChannelMixDecision -- canal OTA (cerrar_ota)", () => {
  it("decide cerrar_ota cuando la ocupación proyectada alcanza el umbral y el canal está abierto, con razón no vacía", () => {
    const decision = evaluateChannelMixDecision(otaConfig({ highDemandOccupancyThresholdPct: 90, isOpen: true }), "2026-12-24", 90);
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("cerrar_ota");
    expect(decision!.channel).toBe("booking.com");
    expect(decision!.stayDate).toBe("2026-12-24");
    expect(decision!.thresholdPct).toBe(90);
    expect(decision!.reason.length).toBeGreaterThan(0);
    expect(decision!.reason).toMatch(/alta_demanda_proyectada/);
  });

  it("decide cerrar_ota también por encima del umbral", () => {
    const decision = evaluateChannelMixDecision(otaConfig({ highDemandOccupancyThresholdPct: 90, isOpen: true }), "2026-12-24", 97.5);
    expect(decision!.action).toBe("cerrar_ota");
  });

  it("no decide nada por debajo del umbral", () => {
    const decision = evaluateChannelMixDecision(otaConfig({ highDemandOccupancyThresholdPct: 90, isOpen: true }), "2026-12-24", 89.9);
    expect(decision).toBeNull();
  });

  it("no decide nada si el canal ya está cerrado, aunque el umbral se cumpla (sin ruido de decisión repetida)", () => {
    const decision = evaluateChannelMixDecision(otaConfig({ highDemandOccupancyThresholdPct: 90, isOpen: false }), "2026-12-24", 99);
    expect(decision).toBeNull();
  });
});

describe("evaluateChannelMixDecision -- canal metasearch (pausar_metasearch / subir_puja)", () => {
  it("decide pausar_metasearch al superar el umbral de pausa, con razón no vacía", () => {
    const decision = evaluateChannelMixDecision(
      metasearchConfig({ pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: true }),
      "2026-12-24",
      86,
    );
    expect(decision!.action).toBe("pausar_metasearch");
    expect(decision!.thresholdPct).toBe(85);
    expect(decision!.reason.length).toBeGreaterThan(0);
    expect(decision!.reason).toMatch(/ocupacion_saturada/);
    expect(decision!.bidRaisePct).toBeUndefined();
  });

  it("decide subir_puja por debajo del umbral de puja, con bidRaisePct y razón no vacía", () => {
    const decision = evaluateChannelMixDecision(
      metasearchConfig({ pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, bidRaisePct: 15, isActive: true }),
      "2026-12-24",
      30,
    );
    expect(decision!.action).toBe("subir_puja");
    expect(decision!.bidRaisePct).toBe(15);
    expect(decision!.reason.length).toBeGreaterThan(0);
    expect(decision!.reason).toMatch(/demanda_insuficiente/);
  });

  it("no decide nada en la banda neutral entre los dos umbrales", () => {
    const decision = evaluateChannelMixDecision(
      metasearchConfig({ pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: true }),
      "2026-12-24",
      60,
    );
    expect(decision).toBeNull();
  });

  it("no decide nada si la campaña ya está pausada, ni para pausar ni para subir puja", () => {
    const paused = metasearchConfig({ pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: false });
    expect(evaluateChannelMixDecision(paused, "2026-12-24", 95)).toBeNull();
    expect(evaluateChannelMixDecision(paused, "2026-12-24", 10)).toBeNull();
  });
});

describe("evaluateChannelMixDecision -- validación de entrada", () => {
  it("lanza ChannelMixEngineError con ocupación fuera de [0, 100]", () => {
    expect(() => evaluateChannelMixDecision(otaConfig(), "2026-12-24", -1)).toThrow(/ocupacion_invalida/);
    expect(() => evaluateChannelMixDecision(otaConfig(), "2026-12-24", 101)).toThrow(/ocupacion_invalida/);
    expect(() => evaluateChannelMixDecision(otaConfig(), "2026-12-24", Number.NaN)).toThrow(ChannelMixEngineError);
  });

  it("lanza sobre fecha de estadía inválida", () => {
    expect(() => evaluateChannelMixDecision(otaConfig(), "no-es-fecha", 95)).toThrow(/fecha_invalida/);
  });

  it("lanza sobre configuración de canal inválida (propaga assertValidChannelMixChannelConfig)", () => {
    expect(() => evaluateChannelMixDecision(otaConfig({ channel: "" }), "2026-12-24", 95)).toThrow(/canal_faltante/);
  });
});

describe("evaluateChannelMix -- batería de canales de un hotel", () => {
  it("cada decisión sintética producida trae una razón no vacía asociada (REQ-REV-006, criterio literal)", () => {
    const channels: ChannelMixChannelConfig[] = [
      otaConfig({ channel: "booking.com", highDemandOccupancyThresholdPct: 90, isOpen: true }),
      otaConfig({ channel: "expedia", highDemandOccupancyThresholdPct: 95, isOpen: true }),
      metasearchConfig({ channel: "google_hotel_ads", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: true }),
      metasearchConfig({ channel: "tripadvisor", pauseOccupancyThresholdPct: 90, raiseBidOccupancyThresholdPct: 35, isActive: true }),
    ];

    // Ocupación proyectada de 92%: cierra booking.com (>=90) pero no expedia (<95);
    // pausa google_hotel_ads (>=85) y tripadvisor (>=90, justo en su propio umbral).
    const decisions = evaluateChannelMix(channels, "2026-12-31", 92);
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason.trim().length).toBeGreaterThan(0);
    }
    expect(decisions.map((d) => `${d.channel}:${d.action}`).sort()).toEqual(
      ["booking.com:cerrar_ota", "google_hotel_ads:pausar_metasearch", "tripadvisor:pausar_metasearch"].sort(),
    );
  });

  it("con ocupación baja, sube puja en ambos metasearch y no toca ninguna OTA", () => {
    const channels: ChannelMixChannelConfig[] = [
      otaConfig({ channel: "booking.com", highDemandOccupancyThresholdPct: 90, isOpen: true }),
      metasearchConfig({ channel: "google_hotel_ads", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: true }),
      metasearchConfig({ channel: "tripadvisor", pauseOccupancyThresholdPct: 90, raiseBidOccupancyThresholdPct: 35, isActive: true }),
    ];
    const decisions = evaluateChannelMix(channels, "2027-01-15", 30);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.action === "subir_puja")).toBe(true);
    expect(decisions.every((d) => d.reason.length > 0)).toBe(true);
  });

  it("devuelve arreglo vacío cuando ningún canal tiene una decisión que aplique", () => {
    const channels: ChannelMixChannelConfig[] = [
      otaConfig({ highDemandOccupancyThresholdPct: 90, isOpen: true }),
      metasearchConfig({ pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, isActive: true }),
    ];
    expect(evaluateChannelMix(channels, "2026-12-24", 60)).toEqual([]);
  });
});
