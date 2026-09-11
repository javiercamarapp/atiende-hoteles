// REQ-REV-006 (P1/F, fuentes BP-087/H02-001/H05-003): verifica contra Postgres REAL
// (embedded-postgres, ADR-003) que `packages/db/migrations/0130_channel_mix_decision.sql`
// es la autoridad de verdad -- no solo la aplicación -- para el criterio literal del
// requisito: "el sistema debe decidir/ejecutar el mix de canal (cerrar OTA en fechas de
// alta demanda, pausar campañas de metasearch al superar umbral de ocupación
// proyectada, subir puja) registrando la razón de cada decisión (verificado: cada
// decisión sintética tiene una razón no vacía asociada)".
//
// El motor de decisión en sí (`evaluateChannelMix`, dominio puro, sin I/O) ya está
// probado exhaustivamente en tests/unit/domain-hotel/channel-mix-engine.spec.ts -- este
// archivo complementa (nunca duplica) esa suite con lo que un test unitario NO puede
// verificar: (a) que la BD real, no solo la app, rechaza una razón vacía o una acción
// inconsistente con el tipo de canal; (b) que "ejecutar" deja el nuevo estado escrito
// en `hotel_channel_mix_config` (is_open/is_active); (c) que solo owner/gm/accountant
// pueden registrar una decisión (RLS), mismo criterio que
// tests/integration/revenue/revenue-engine-gate.spec.ts frente a 0082.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateChannelMix, type ChannelMixChannelConfig, type ChannelMixDecision } from "@atiende-hoteles/domain-hotel";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";

interface MixCanalHotel {
  orgId: string;
  hotelId: string;
  ownerId: string;
  accountantId: string;
  frontdeskId: string;
}

describe("REQ-REV-006: decide/ejecuta el mix de canal registrando la razón de cada decisión", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  // Cada test siembra su PROPIO org/hotel (aislado, mismo criterio que
  // tests/integration/revenue/revenue-engine-gate.spec.ts::seedRevenueHotel) para que
  // la configuración/decisiones de un test nunca contaminen a otro.
  async function seedMixCanalHotel(): Promise<MixCanalHotel> {
    const suffix = randomUUID();
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>("insert into public.org (name) values ($1) returning id;", [
      `Org mix-canal ${suffix}`,
    ]);
    const orgId = orgRows[0]!.id;

    const { rows: locationRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
      [orgId, `Hotel mix-canal ${suffix}`],
    );
    const hotelId = locationRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);

    async function seedStaff(role: string): Promise<string> {
      const { rows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
        [`${role}-${suffix}@atiende-hoteles.test`, `${role} de prueba`],
      );
      const userId = rows[0]!.id;
      await fixture.engine.admin.query("insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, $4);", [
        orgId,
        hotelId,
        userId,
        role,
      ]);
      return userId;
    }

    const ownerId = await seedStaff("owner");
    const accountantId = await seedStaff("accountant");
    const frontdeskId = await seedStaff("frontdesk");

    return { orgId, hotelId, ownerId, accountantId, frontdeskId };
  }

  async function insertOtaConfig(h: MixCanalHotel, opts: { channel?: string; thresholdPct?: number; isOpen?: boolean } = {}) {
    const channel = opts.channel ?? "booking.com";
    await fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
      db.query(
        `insert into public.hotel_channel_mix_config
           (org_id, hotel_id, channel, channel_type, high_demand_occupancy_threshold_pct, is_open)
         values ($1, $2, $3, 'ota', $4, $5);`,
        [h.orgId, h.hotelId, channel, opts.thresholdPct ?? 90, opts.isOpen ?? true],
      ),
    );
    return channel;
  }

  async function insertMetasearchConfig(
    h: MixCanalHotel,
    opts: { channel?: string; pausePct?: number; raisePct?: number; bidRaisePct?: number; isActive?: boolean } = {},
  ) {
    const channel = opts.channel ?? "google_hotel_ads";
    await fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
      db.query(
        `insert into public.hotel_channel_mix_config
           (org_id, hotel_id, channel, channel_type, pause_occupancy_threshold_pct, raise_bid_occupancy_threshold_pct, bid_raise_pct, is_active)
         values ($1, $2, $3, 'metasearch', $4, $5, $6, $7);`,
        [h.orgId, h.hotelId, channel, opts.pausePct ?? 85, opts.raisePct ?? 40, opts.bidRaisePct ?? 15, opts.isActive ?? true],
      ),
    );
    return channel;
  }

  /** Ejecuta el motor puro sobre la config declarada (síntesis de canales in-memory,
   *  mismo dato que ya viven las columnas de `hotel_channel_mix_config`) y persiste
   *  cada decisión resultante -- el flujo real "decide (dominio) -> ejecuta/registra
   *  (Postgres)" que orquestaría `apps/api`. */
  async function runEngineAndPersist(
    h: MixCanalHotel,
    channels: readonly ChannelMixChannelConfig[],
    stayDate: string,
    occupancyProjectedPct: number,
    opts: { asUser?: string } = {},
  ): Promise<ChannelMixDecision[]> {
    const decisions = evaluateChannelMix(channels, stayDate, occupancyProjectedPct);
    for (const decision of decisions) {
      await fixture.engine.withAppSession({ userId: opts.asUser ?? h.ownerId }, (db) =>
        db.query(
          `insert into public.channel_mix_decision
             (org_id, hotel_id, channel, channel_type, action, stay_date, occupancy_projected_pct, threshold_pct, bid_raise_pct, reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
          [
            h.orgId,
            h.hotelId,
            decision.channel,
            decision.channelType,
            decision.action,
            decision.stayDate,
            decision.occupancyProjectedPct,
            decision.thresholdPct,
            decision.bidRaisePct ?? null,
            decision.reason,
          ],
        ),
      );
    }
    return decisions;
  }

  it("una ocupación proyectada de alta demanda decide y persiste cerrar_ota con razón no vacía, y ejecuta el cierre en la config vigente", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });

    const decisions = await runEngineAndPersist(
      h,
      [{ channel, channelType: "ota", highDemandOccupancyThresholdPct: 90, isOpen: true }],
      "2026-12-24",
      95,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("cerrar_ota");

    const { rows } = await fixture.engine.admin.query<{ action: string; reason: string; stay_date: string }>(
      "select action, reason, stay_date::text from public.channel_mix_decision where hotel_id = $1;",
      [h.hotelId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("cerrar_ota");
    expect(rows[0]!.reason.trim().length).toBeGreaterThan(0);
    expect(rows[0]!.stay_date).toBe("2026-12-24");

    // "Ejecuta": el estado vigente del canal quedó cerrado tras la decisión (trigger
    // channel_mix_decision_guard_trg).
    const { rows: configRows } = await fixture.engine.admin.query<{ is_open: boolean }>(
      "select is_open from public.hotel_channel_mix_config where hotel_id = $1 and channel = $2;",
      [h.hotelId, channel],
    );
    expect(configRows[0]!.is_open).toBe(false);
  });

  it("una ocupación proyectada que supera el umbral de pausa decide y persiste pausar_metasearch, y desactiva la campaña en la config vigente", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertMetasearchConfig(h, { pausePct: 85, raisePct: 40, bidRaisePct: 15, isActive: true });

    const decisions = await runEngineAndPersist(
      h,
      [{ channel, channelType: "metasearch", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, bidRaisePct: 15, isActive: true }],
      "2026-12-24",
      90,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("pausar_metasearch");

    const { rows } = await fixture.engine.admin.query<{ action: string; reason: string; bid_raise_pct: string | null }>(
      "select action, reason, bid_raise_pct from public.channel_mix_decision where hotel_id = $1;",
      [h.hotelId],
    );
    expect(rows[0]!.action).toBe("pausar_metasearch");
    expect(rows[0]!.reason.trim().length).toBeGreaterThan(0);
    expect(rows[0]!.bid_raise_pct).toBeNull();

    const { rows: configRows } = await fixture.engine.admin.query<{ is_active: boolean }>(
      "select is_active from public.hotel_channel_mix_config where hotel_id = $1 and channel = $2;",
      [h.hotelId, channel],
    );
    expect(configRows[0]!.is_active).toBe(false);
  });

  it("una ocupación proyectada baja decide y persiste subir_puja con el porcentaje de alza, sin desactivar la campaña", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertMetasearchConfig(h, { pausePct: 85, raisePct: 40, bidRaisePct: 20, isActive: true });

    const decisions = await runEngineAndPersist(
      h,
      [{ channel, channelType: "metasearch", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, bidRaisePct: 20, isActive: true }],
      "2027-02-14",
      25,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("subir_puja");

    const { rows } = await fixture.engine.admin.query<{ action: string; reason: string; bid_raise_pct: string }>(
      "select action, reason, bid_raise_pct from public.channel_mix_decision where hotel_id = $1;",
      [h.hotelId],
    );
    expect(rows[0]!.action).toBe("subir_puja");
    expect(rows[0]!.reason.trim().length).toBeGreaterThan(0);
    expect(Number(rows[0]!.bid_raise_pct)).toBe(20);

    // subir_puja NO desactiva la campaña (sigue activa, solo cambia la puja real fuera
    // de este esquema).
    const { rows: configRows } = await fixture.engine.admin.query<{ is_active: boolean }>(
      "select is_active from public.hotel_channel_mix_config where hotel_id = $1 and channel = $2;",
      [h.hotelId, channel],
    );
    expect(configRows[0]!.is_active).toBe(true);
  });

  it("una batería de canales/fechas sintéticos produce varias decisiones y CADA una trae una razón no vacía persistida (criterio literal del requisito)", async () => {
    const h = await seedMixCanalHotel();
    const otaHigh = await insertOtaConfig(h, { channel: "booking.com", thresholdPct: 90, isOpen: true });
    const otaLow = await insertOtaConfig(h, { channel: "expedia", thresholdPct: 95, isOpen: true });
    const metaPause = await insertMetasearchConfig(h, { channel: "google_hotel_ads", pausePct: 85, raisePct: 40, bidRaisePct: 15, isActive: true });
    const metaRaise = await insertMetasearchConfig(h, { channel: "trivago", pausePct: 90, raisePct: 35, bidRaisePct: 25, isActive: true });

    const channels: ChannelMixChannelConfig[] = [
      { channel: otaHigh, channelType: "ota", highDemandOccupancyThresholdPct: 90, isOpen: true },
      { channel: otaLow, channelType: "ota", highDemandOccupancyThresholdPct: 95, isOpen: true },
      { channel: metaPause, channelType: "metasearch", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, bidRaisePct: 15, isActive: true },
      { channel: metaRaise, channelType: "metasearch", pauseOccupancyThresholdPct: 90, raiseBidOccupancyThresholdPct: 35, bidRaisePct: 25, isActive: true },
    ];

    // Fecha de alta demanda (92%): el conteo/verificación de abajo usa lo que el MOTOR
    // realmente produjo (`altaDemanda.length`), nunca un número asumido a mano -- esta
    // prueba certifica "toda decisión persistida trae razón", no cuántas decisiones
    // exactas produce cada combinación de umbrales (eso ya lo cubre el test unitario).
    const altaDemanda = await runEngineAndPersist(h, channels, "2026-12-31", 92);
    // Fecha de baja demanda: sube puja en ambos metasearch, ninguna OTA se cierra.
    const bajaDemanda = await runEngineAndPersist(h, channels, "2027-01-15", 20);

    const totalDecisionsProducidas = altaDemanda.length + bajaDemanda.length;
    expect(totalDecisionsProducidas).toBeGreaterThan(0);

    const { rows } = await fixture.engine.admin.query<{ reason: string; action: string }>(
      "select reason, action from public.channel_mix_decision where hotel_id = $1 order by decided_at asc;",
      [h.hotelId],
    );
    // Verificado: CADA decisión sintética persistida tiene una razón no vacía asociada.
    expect(rows.length).toBe(totalDecisionsProducidas);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.reason).not.toBeNull();
      expect(typeof row.reason).toBe("string");
      expect(row.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("Postgres RECHAZA un intento directo de insertar una decisión con razón vacía o en blanco (autoridad real, no solo la aplicación)", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.channel_mix_decision
             (org_id, hotel_id, channel, channel_type, action, stay_date, occupancy_projected_pct, threshold_pct, reason)
           values ($1, $2, $3, 'ota', 'cerrar_ota', '2026-12-24', 95, 90, '');`,
          [h.orgId, h.hotelId, channel],
        ),
      ),
    ).rejects.toThrow();

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.channel_mix_decision
             (org_id, hotel_id, channel, channel_type, action, stay_date, occupancy_projected_pct, threshold_pct, reason)
           values ($1, $2, $3, 'ota', 'cerrar_ota', '2026-12-24', 95, 90, '   ');`,
          [h.orgId, h.hotelId, channel],
        ),
      ),
    ).rejects.toThrow();

    const { rows } = await fixture.engine.admin.query("select 1 from public.channel_mix_decision where hotel_id = $1;", [h.hotelId]);
    expect(rows).toHaveLength(0);
  });

  it("Postgres RECHAZA una acción inconsistente con el tipo de canal (subir_puja sobre un canal 'ota')", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.channel_mix_decision
             (org_id, hotel_id, channel, channel_type, action, stay_date, occupancy_projected_pct, threshold_pct, bid_raise_pct, reason)
           values ($1, $2, $3, 'ota', 'subir_puja', '2026-12-24', 20, 40, 15, 'razón cualquiera');`,
          [h.orgId, h.hotelId, channel],
        ),
      ),
    ).rejects.toThrow();
  });

  it("Postgres RECHAZA una configuración de canal 'ota' con campos de metasearch (o viceversa) -- consistencia de esquema", async () => {
    const h = await seedMixCanalHotel();

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.hotel_channel_mix_config
             (org_id, hotel_id, channel, channel_type, high_demand_occupancy_threshold_pct, is_open, is_active)
           values ($1, $2, 'booking.com', 'ota', 90, true, true);`,
          [h.orgId, h.hotelId],
        ),
      ),
    ).rejects.toThrow();

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.hotel_channel_mix_config
             (org_id, hotel_id, channel, channel_type, pause_occupancy_threshold_pct, raise_bid_occupancy_threshold_pct, bid_raise_pct, is_active, is_open)
           values ($1, $2, 'google_hotel_ads', 'metasearch', 85, 40, 15, true, true);`,
          [h.orgId, h.hotelId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("Postgres RECHAZA bandas de pausa/puja solapadas o invertidas en la configuración de metasearch", async () => {
    const h = await seedMixCanalHotel();

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(
          `insert into public.hotel_channel_mix_config
             (org_id, hotel_id, channel, channel_type, pause_occupancy_threshold_pct, raise_bid_occupancy_threshold_pct, bid_raise_pct, is_active)
           values ($1, $2, 'google_hotel_ads', 'metasearch', 50, 60, 15, true);`,
          [h.orgId, h.hotelId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("frontdesk NO puede registrar una decisión de mix de canal (RLS: solo owner/gm/accountant)", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });

    await expect(
      fixture.engine.withAppSession({ userId: h.frontdeskId }, (db) =>
        db.query(
          `insert into public.channel_mix_decision
             (org_id, hotel_id, channel, channel_type, action, stay_date, occupancy_projected_pct, threshold_pct, reason)
           values ($1, $2, $3, 'ota', 'cerrar_ota', '2026-12-24', 95, 90, 'alta demanda proyectada');`,
          [h.orgId, h.hotelId, channel],
        ),
      ),
    ).rejects.toThrow();

    const { rows } = await fixture.engine.admin.query("select 1 from public.channel_mix_decision where hotel_id = $1;", [h.hotelId]);
    expect(rows).toHaveLength(0);
  });

  it("accountant SÍ puede registrar una decisión de mix de canal (mismo nivel que revenue_backtest_run)", async () => {
    const h = await seedMixCanalHotel();
    const channel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });

    await runEngineAndPersist(h, [{ channel, channelType: "ota", highDemandOccupancyThresholdPct: 90, isOpen: true }], "2026-12-24", 95, {
      asUser: h.accountantId,
    });

    const { rows } = await fixture.engine.admin.query("select 1 from public.channel_mix_decision where hotel_id = $1;", [h.hotelId]);
    expect(rows).toHaveLength(1);
  });

  it("no genera ni persiste ninguna decisión cuando la ocupación proyectada está en la banda neutral (sin ruido)", async () => {
    const h = await seedMixCanalHotel();
    const otaChannel = await insertOtaConfig(h, { thresholdPct: 90, isOpen: true });
    const metaChannel = await insertMetasearchConfig(h, { pausePct: 85, raisePct: 40, bidRaisePct: 15, isActive: true });

    const decisions = await runEngineAndPersist(
      h,
      [
        { channel: otaChannel, channelType: "ota", highDemandOccupancyThresholdPct: 90, isOpen: true },
        { channel: metaChannel, channelType: "metasearch", pauseOccupancyThresholdPct: 85, raiseBidOccupancyThresholdPct: 40, bidRaisePct: 15, isActive: true },
      ],
      "2026-12-24",
      60,
    );
    expect(decisions).toHaveLength(0);

    const { rows } = await fixture.engine.admin.query("select 1 from public.channel_mix_decision where hotel_id = $1;", [h.hotelId]);
    expect(rows).toHaveLength(0);
  });
});
