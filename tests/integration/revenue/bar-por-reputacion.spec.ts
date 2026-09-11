// REQ-REV-017 (P2/F): "El sistema debe recomendar un ajuste de tarifa (BAR) cuando el
// índice de reputación suba sobre un umbral en una ventana de tiempo definida."
// Verificado contra Postgres REAL (embedded-postgres, ADR-003), criterio literal de
// docs/ACEPTACION.md: "verificado con serie sintética de reputación que cruza el
// umbral" -- las reseñas sintéticas de este archivo se insertan directo en
// `guest_review` (0097, la misma tabla que puebla REQ-CRM-002/`routes/reputacion.ts`)
// con `created_at` explícito para armar una serie temporal controlada, y
// `evaluarAjusteBarPorReputacion()` (`apps/api/src/jobs/barReputacionEvaluator.ts`) se
// ejercita contra la base real de punta a punta: lee `guest_review`, calcula el índice
// vía `@atiende-hoteles/domain-hotel` (puro, ya cubierto por
// tests/unit/domain-hotel/bar-por-reputacion.spec.ts) y persiste la recomendación en
// `bar_reputation_recommendation` vía `record_bar_reputation_recommendation()` (0130).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluarAjusteBarPorReputacion } from "../../../apps/api/src/jobs/barReputacionEvaluator.ts";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const AHORA = new Date("2026-09-11T12:00:00Z");
const UMBRAL = 75;
const VENTANA_DIAS = 30;

interface RevHotel {
  orgId: string;
  hotelId: string;
  ownerId: string;
  frontdeskId: string;
}

function diasAtras(dias: number, ahora: Date = AHORA): Date {
  return new Date(ahora.getTime() - dias * DAY_MS);
}

/** Convierte un índice deseado (0..100, la misma escala que `sentimentScoreToIndice`)
 *  al `sentiment_score` (-1..1) que hay que persistir en `guest_review` para que, tras
 *  el remapeo real del módulo bajo prueba, produzca ese índice -- inverso exacto de
 *  `sentimentScoreToIndice`, para que el test arme la serie en la unidad que de verdad
 *  importa (el índice 0..100 del criterio de aceptación) sin duplicar la fórmula de
 *  producción. */
function indiceASentimentScore(indice: number): number {
  return Math.max(-1, Math.min(1, (indice / 100) * 2 - 1));
}

describe("REQ-REV-017: recomendación de ajuste de BAR cuando el índice de reputación cruza el umbral", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  async function seedHotel(): Promise<RevHotel> {
    const suffix = randomUUID();
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      [`Org bar-reputacion ${suffix}`],
    );
    const orgId = orgRows[0]!.id;

    const { rows: locationRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
      [orgId, `Hotel bar-reputacion ${suffix}`],
    );
    const hotelId = locationRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);

    const { rows: ownerRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`owner-${suffix}@atiende-hoteles.test`, "Owner de prueba"],
    );
    const ownerId = ownerRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');", [
      orgId,
      hotelId,
      ownerId,
    ]);

    const { rows: frontdeskRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`frontdesk-${suffix}@atiende-hoteles.test`, "Frontdesk de prueba"],
    );
    const frontdeskId = frontdeskRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'frontdesk');",
      [orgId, hotelId, frontdeskId],
    );

    return { orgId, hotelId, ownerId, frontdeskId };
  }

  /** Inserta una reseña sintética directo en `guest_review` con un `created_at`
   *  explícito -- mismo tipo de fila real que produce `routes/reputacion.ts`, solo que
   *  aquí se controla la fecha para armar la serie temporal del test. */
  async function seedReview(h: RevHotel, diasAtrasN: number, indiceDeseado: number): Promise<void> {
    const sentimentScore = indiceASentimentScore(indiceDeseado);
    const sentimentLabel =
      sentimentScore <= -0.6 ? "muy_negativo" : sentimentScore <= -0.2 ? "negativo" : sentimentScore < 0.2 ? "neutral" : sentimentScore < 0.6 ? "positivo" : "muy_positivo";
    await fixture.engine.admin.query(
      `insert into public.guest_review
         (tenant_id, hotel_id, source, texto, sentiment, sentiment_score, created_at)
       values ($1, $2, 'encuesta_propia', $3, $4, $5, $6);`,
      [h.orgId, h.hotelId, `Reseña sintética índice=${indiceDeseado}`, sentimentLabel, sentimentScore, diasAtras(diasAtrasN).toISOString()],
    );
  }

  it("CASO POSITIVO: una serie real de reseñas que cruza el umbral genera una recomendación persistida", async () => {
    const hotel = await seedHotel();
    // Serie diaria: empieza bajo el umbral (75) y sube -- cruza el día 4.
    await seedReview(hotel, 20, 60);
    await seedReview(hotel, 15, 62);
    await seedReview(hotel, 10, 68);
    await seedReview(hotel, 6, 72); // todavía bajo el umbral
    await seedReview(hotel, 4, 84); // cruza aquí
    await seedReview(hotel, 2, 88);
    await seedReview(hotel, 0, 90);

    const resultado = await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );

    expect(resultado.recomendacion).not.toBeNull();
    expect(resultado.recomendacion!.indiceAntesDeCruce).toBeCloseTo(72, 0);
    expect(resultado.recomendacion!.indiceActual).toBeCloseTo(90, 0);
    expect(resultado.recomendacion!.ajustePorcentaje).toBeGreaterThanOrEqual(10);
    expect(resultado.recomendacion!.ajustePorcentaje).toBeLessThanOrEqual(15);
    expect(resultado.isNew).toBe(true);
    expect(resultado.recommendationId).not.toBeNull();

    // La fila persistida REAL en Postgres debe reflejar exactamente lo que decidió el
    // cálculo puro -- esto es lo que REQ-REV-017 exige que "el sistema" haga, no solo
    // que la función pura decida bien en memoria.
    const { rows } = await fixture.engine.admin.query<{
      hotel_id: string;
      ajuste_porcentaje: string;
      status: string;
      umbral: string;
      ventana_dias: number;
    }>("select hotel_id, ajuste_porcentaje::text as ajuste_porcentaje, status, umbral::text as umbral, ventana_dias from public.bar_reputation_recommendation where id = $1;", [
      resultado.recommendationId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hotel_id).toBe(hotel.hotelId);
    expect(Number(rows[0]!.ajuste_porcentaje)).toBe(resultado.recomendacion!.ajustePorcentaje);
    expect(rows[0]!.status).toBe("pendiente");
    expect(Number(rows[0]!.umbral)).toBe(UMBRAL);
    expect(rows[0]!.ventana_dias).toBe(VENTANA_DIAS);
  });

  it("IDEMPOTENCIA: re-evaluar el MISMO cruce no duplica la recomendación (mismo criterio que record_fraud_alert)", async () => {
    const hotel = await seedHotel();
    await seedReview(hotel, 10, 60);
    await seedReview(hotel, 5, 82);
    await seedReview(hotel, 0, 85);

    const primera = await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );
    expect(primera.isNew).toBe(true);

    // Una segunda corrida del mismo evaluador contra el mismo estado (el escenario
    // real: el planificador reevalúa periódicamente mientras el índice se mantiene
    // sobre el umbral) NO debe insertar una segunda fila.
    const segunda = await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );
    expect(segunda.isNew).toBe(false);
    expect(segunda.recommendationId).toBe(primera.recommendationId);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.bar_reputation_recommendation where hotel_id = $1;",
      [hotel.hotelId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("CASO NEGATIVO: una serie que nunca cruza el umbral no genera ninguna recomendación ni fila", async () => {
    const hotel = await seedHotel();
    await seedReview(hotel, 20, 40);
    await seedReview(hotel, 15, 45);
    await seedReview(hotel, 10, 50);
    await seedReview(hotel, 5, 55);
    await seedReview(hotel, 0, 60);

    const resultado = await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );

    expect(resultado.recomendacion).toBeNull();
    expect(resultado.isNew).toBe(false);
    expect(resultado.recommendationId).toBeNull();

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.bar_reputation_recommendation where hotel_id = $1;",
      [hotel.hotelId],
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("CASO NEGATIVO: sin reseñas en la ventana no hay ni cruce ni error", async () => {
    const hotel = await seedHotel();
    // Una reseña, pero MUY vieja (fuera de la ventana de 30 días).
    await seedReview(hotel, 200, 90);

    const resultado = await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );

    expect(resultado.puntosEnVentana).toBe(0);
    expect(resultado.recomendacion).toBeNull();
  });

  it("RLS real: owner/gm ven la recomendación, frontdesk (fuera de la política de este REQ) no", async () => {
    const hotel = await seedHotel();
    await seedReview(hotel, 10, 60);
    await seedReview(hotel, 5, 82);
    await seedReview(hotel, 0, 85);
    await evaluarAjusteBarPorReputacion(
      fixture.engine.admin,
      { hotelId: hotel.hotelId, tenantId: hotel.orgId },
      { now: () => AHORA, umbral: UMBRAL, ventanaDias: VENTANA_DIAS },
    );

    const asOwner = await fixture.engine.withAppSession({ userId: hotel.ownerId }, (db) =>
      db.query<{ id: string }>("select id from public.bar_reputation_recommendation where hotel_id = $1;", [hotel.hotelId]),
    );
    expect(asOwner.rows.length).toBe(1);

    const asFrontdesk = await fixture.engine.withAppSession({ userId: hotel.frontdeskId }, (db) =>
      db.query<{ id: string }>("select id from public.bar_reputation_recommendation where hotel_id = $1;", [hotel.hotelId]),
    );
    expect(asFrontdesk.rows.length).toBe(0);
  });
});
