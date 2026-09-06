// REQ-REV-013: planificador de night audit "en proceso con lock por hotel e
// idempotencia, ejecutable también por CLI" (apps/api/src/jobs/nightAuditScheduler.ts,
// scripts/run-night-audit-scheduler.ts). La lógica de negocio del night audit en sí
// (posteo de hospedaje, no-shows, resumen de caja) ya está cubierta por
// tests/integration/revenue/night-audit.spec.ts -- este archivo prueba SOLO el
// planificador: hora local del hotel, fecha de negocio a cerrar, y el lock por hotel
// EN PROCESO que evita una segunda corrida concurrente del mismo hotel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";
import {
  businessDateToClose,
  localHour,
  loadHotelsForNightAudit,
  NightAuditScheduler,
} from "../../../apps/api/src/jobs/nightAuditScheduler.ts";

describe("businessDateToClose / localHour (funciones puras)", () => {
  it("América/Ciudad_de_México (UTC-6, sin horario de verano desde 2022): calcula el día anterior local", () => {
    // 2026-03-15T10:00:00Z -> local 2026-03-15 04:00 -> día a cerrar: 2026-03-14
    const now = new Date("2026-03-15T10:00:00Z");
    expect(localHour(now, "America/Mexico_City")).toBe(4);
    expect(businessDateToClose(now, "America/Mexico_City")).toBe("2026-03-14");
  });

  it("cruza medianoche local correctamente (justo antes/después de las 00:00 local)", () => {
    // 06:00Z = 00:00 local (medianoche exacta) en America/Mexico_City.
    const medianocheLocal = new Date("2026-03-15T06:00:00Z");
    expect(localHour(medianocheLocal, "America/Mexico_City")).toBe(0);
    expect(businessDateToClose(medianocheLocal, "America/Mexico_City")).toBe("2026-03-14");

    // Un minuto antes: sigue siendo el día local anterior (2026-03-14 23:59).
    const justoAntes = new Date("2026-03-15T05:59:00Z");
    expect(businessDateToClose(justoAntes, "America/Mexico_City")).toBe("2026-03-13");
  });

  it("cruza el fin de año local correctamente", () => {
    // 2027-01-01T05:00:00Z -> local 2026-12-31 23:00 -> día a cerrar: 2026-12-30
    const now = new Date("2027-01-01T05:00:00Z");
    expect(businessDateToClose(now, "America/Mexico_City")).toBe("2026-12-30");
  });
});

describe("NightAuditScheduler.tick (integración real contra embedded-postgres)", () => {
  let fixture: PgFixture;
  let hotelId: string;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    hotelId = fixture.seed.hotels[0]!.id;
    tenantId = fixture.seed.orgId;
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("loadHotelsForNightAudit lee id/tenantId/timezone reales de public.hotel", async () => {
    const hoteles = await loadHotelsForNightAudit(fixture.engine.admin);
    const hotel = hoteles.find((h) => h.id === hotelId);
    expect(hotel).toBeTruthy();
    expect(hotel!.tenantId).toBe(tenantId);
    expect(hotel!.timezone).toBe("America/Mexico_City"); // default de migrations/0023
  });

  it("fuera de horario local (antes de runHourLocal): omite el hotel, no crea corrida", async () => {
    const scheduler = new NightAuditScheduler(fixture.engine.admin, {
      runHourLocal: 3,
      now: () => new Date("2026-03-15T06:00:00Z"), // 00:00 local -> antes de las 03:00
    });
    const [resultado] = await scheduler.tick([{ id: hotelId, tenantId, timezone: "America/Mexico_City" }]);
    expect(resultado!.ran).toBe(false);
    expect(resultado!.skippedReason).toBe("fuera_de_horario");

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.night_audit_run where hotel_id = $1 and business_date = '2026-03-14';",
      [hotelId],
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("dentro de horario: corre el night audit del día anterior local y lo deja completado", async () => {
    const scheduler = new NightAuditScheduler(fixture.engine.admin, {
      runHourLocal: 3,
      now: () => new Date("2026-03-16T10:00:00Z"), // 04:00 local -> ya pasó las 03:00
    });
    const [resultado] = await scheduler.tick([{ id: hotelId, tenantId, timezone: "America/Mexico_City" }]);
    expect(resultado!.ran).toBe(true);
    expect(resultado!.businessDate).toBe("2026-03-15");
    expect(resultado!.summary).toBeTruthy();

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.night_audit_run where hotel_id = $1 and business_date = '2026-03-15';",
      [hotelId],
    );
    expect(rows[0]!.status).toBe("completado");
  });

  it("lock por hotel EN PROCESO: dos tick() concurrentes del mismo scheduler nunca corren el mismo hotel a la vez", async () => {
    const scheduler = new NightAuditScheduler(fixture.engine.admin, {
      runHourLocal: 3,
      now: () => new Date("2026-03-17T10:00:00Z"), // día nuevo, no tocado por las pruebas anteriores
    });
    const hotels = [{ id: hotelId, tenantId, timezone: "America/Mexico_City" }];

    const [resultados1, resultados2] = await Promise.all([scheduler.tick(hotels), scheduler.tick(hotels)]);
    const combinados = [...resultados1, ...resultados2];

    const corrieron = combinados.filter((r) => r.ran);
    const omitidosPorLock = combinados.filter((r) => r.skippedReason === "ya_en_progreso_en_este_proceso");

    // Exactamente UNA de las dos llamadas concurrentes ejecutó el night audit del
    // hotel; la otra lo vio "en progreso en este proceso" y lo omitió -- nunca las dos
    // corriendo a la vez para el mismo hotel.
    expect(corrieron).toHaveLength(1);
    expect(omitidosPorLock).toHaveLength(1);
    expect(scheduler.hotelesEnProceso()).toHaveLength(0); // el lock se libera siempre al terminar

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.night_audit_run where hotel_id = $1 and business_date = '2026-03-16';",
      [hotelId],
    );
    expect(rows).toHaveLength(1); // idempotencia real de fondo: 1 sola corrida guardada
    expect(rows[0]!.status).toBe("completado");
  });

  it("un hotel con error no detiene el procesamiento de los demás hoteles del mismo tick", async () => {
    const scheduler = new NightAuditScheduler(fixture.engine.admin, {
      runHourLocal: 3,
      now: () => new Date("2026-03-18T10:00:00Z"),
    });
    const hotelInexistente = "00000000-0000-0000-0000-000000000000";
    const resultados = await scheduler.tick([
      { id: hotelInexistente, tenantId, timezone: "America/Mexico_City" },
      { id: hotelId, tenantId, timezone: "America/Mexico_City" },
    ]);

    expect(resultados[0]!.ran).toBe(false);
    expect(resultados[0]!.error).toBeTruthy();
    expect(resultados[1]!.ran).toBe(true);
  });
});
