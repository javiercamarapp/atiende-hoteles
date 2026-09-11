// REQ-CRM-010 (P3/F) -- "El sistema debe capturar contenido generado por el huésped
// (UGC) vía WhatsApp post-estancia con registro explícito de consentimiento de uso, y
// generar un calendario mensual de contenido/publicaciones."
//
// Criterio de aceptación exacto (docs/ACEPTACION.md): "verificado: UGC sin
// consentimiento → 0 uso permitido". Este archivo lo ejercita de punta a punta contra
// la API real y `embedded-postgres` (ADR-003), nunca contra un mock:
//  1) Capturar UGC sobre una reserva que TODAVÍA no llega a post-estancia -- rechazado
//     (409): "post-estancia" es parte literal del criterio, no una preferencia de UX.
//  2) Capturar UGC post-estancia con consentimiento NEGADO (`granted=false`) -- se
//     captura igual (el dato no se descarta, 201) pero el calendario mensual generado
//     jamás debe incluirlo: el caso negativo exacto del criterio.
//  3) Capturar UGC post-estancia con consentimiento OTORGADO -- sí aparece en el
//     calendario.
//  4) El calendario reporta cuánto quedó excluido por falta de consentimiento, sin
//     fabricar publicaciones que no puede respaldar con contenido consentido.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: REQ-CRM-010 -- UGC sin consentimiento → 0 uso permitido", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let guestId: string;

  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  /** Crea una reservación para `guestId` y la transiciona al estado pedido -- misma
   *  cadena completa (confirmada -> check_in -> en_estancia -> check_out) que exige la
   *  máquina de estados real (reservationStateMachine.ts + trigger de Postgres,
   *  migración 0006), nunca un salto directo. */
  async function crearReserva(status: "confirmada" | "check_out"): Promise<string> {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;

    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate, checkOutDate, guestId }),
    });
    expect(created.status).toBe(201);
    const { id: reservationId } = (await created.json()) as { id: string };

    const cadena: Record<typeof status, string[]> = {
      confirmada: ["confirmada"],
      check_out: ["confirmada", "check_in", "en_estancia", "check_out"],
    };
    for (const toStatus of cadena[status]) {
      const t = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify({ toStatus }),
      });
      expect(t.status).toBe(200);
    }
    return reservationId;
  }

  interface UgcSubmissionBody {
    id: string;
    consentimientoOtorgado: boolean;
    referenciaMedia: string;
  }

  async function capturarUgc(
    reservationId: string,
    granted: boolean,
    mediaReference: string,
  ): Promise<Response> {
    return fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/ugc`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        reservationId,
        mediaType: "foto",
        mediaReference,
        caption: "Vista desde la habitación",
        granted,
        avisoVersion: `aviso-ugc-v1-${Date.now()}`,
      }),
    });
  }

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);

    const guestRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ nombre: "Huésped UGC Consentimiento" }),
    });
    expect(guestRes.status).toBe(201);
    guestId = ((await guestRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("capturar UGC sobre una reserva que AÚN no llega a post-estancia es rechazado (409)", async () => {
    const reservationId = await crearReserva("confirmada");
    const res = await capturarUgc(reservationId, true, "wamid.no-post-estancia");
    expect(res.status).toBe(409);
  });

  it("post-estancia, con consentimiento NEGADO: se captura igual (201) pero queda marcado como no otorgado", async () => {
    const reservationId = await crearReserva("check_out");
    const res = await capturarUgc(reservationId, false, "wamid.sin-consentimiento");
    expect(res.status).toBe(201);
    const body = (await res.json()) as UgcSubmissionBody;
    expect(body.consentimientoOtorgado).toBe(false);
    expect(body.referenciaMedia).toBe("wamid.sin-consentimiento");
  });

  it("post-estancia, con consentimiento OTORGADO: se captura y queda marcado como otorgado", async () => {
    const reservationId = await crearReserva("check_out");
    const res = await capturarUgc(reservationId, true, "wamid.con-consentimiento");
    expect(res.status).toBe(201);
    const body = (await res.json()) as UgcSubmissionBody;
    expect(body.consentimientoOtorgado).toBe(true);
  });

  it("el calendario mensual generado NUNCA incluye la pieza sin consentimiento -- 0 uso permitido", async () => {
    const mes = new Date().toISOString().slice(0, 7);
    const res = await fixture.app.request(`/hoteles/${hotelId}/ugc/calendario?mes=${mes}&postsPorSemana=10`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publicaciones: Array<{ referenciaMedia: string }>;
      excluidoPorFaltaDeConsentimiento: number;
    };

    const referencias = body.publicaciones.map((p) => p.referenciaMedia);
    expect(referencias).toContain("wamid.con-consentimiento");
    expect(referencias).not.toContain("wamid.sin-consentimiento");
    expect(body.excluidoPorFaltaDeConsentimiento).toBeGreaterThanOrEqual(1);
  });

  it("si NINGUNA pieza capturada en un hotel tiene consentimiento otorgado, su calendario generado sale vacío -- 0 uso permitido", async () => {
    // Hotel B, completamente aislado del hotel A usado en los tests anteriores (mismo
    // criterio de aislamiento por hotel que audit-log-concurrencia.spec.ts/
    // payment-preauth-purga.spec.ts): así "0 publicaciones" no depende de contar cuánto
    // dejaron otros tests, sino de que este hotel, con SOLO UGC sin consentimiento,
    // nunca produce ni una sola entrada.
    const hotelB = fixture.seed.hotels[1]!;
    const hotelBId = hotelB.id;
    const roomTypeBId = hotelB.roomTypes[0]!.id;
    const gmTokenB = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
    const authB = { authorization: `Bearer ${gmTokenB}`, "content-type": "application/json" };

    const guestRes = await fixture.app.request(`/hoteles/${hotelBId}/huespedes`, {
      method: "POST",
      headers: authB,
      body: JSON.stringify({ nombre: "Huésped Hotel B Solo Sin Consentimiento" }),
    });
    expect(guestRes.status).toBe(201);
    const guestBId = ((await guestRes.json()) as { id: string }).id;

    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    const created = await fixture.app.request(`/hoteles/${hotelBId}/reservas`, {
      method: "POST",
      headers: { ...authB, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId: roomTypeBId, checkInDate, checkOutDate, guestId: guestBId }),
    });
    expect(created.status).toBe(201);
    const reservationId = ((await created.json()) as { id: string }).id;
    for (const toStatus of ["confirmada", "check_in", "en_estancia", "check_out"]) {
      const t = await fixture.app.request(`/hoteles/${hotelBId}/reservas/${reservationId}/transicion`, {
        method: "PATCH",
        headers: authB,
        body: JSON.stringify({ toStatus }),
      });
      expect(t.status).toBe(200);
    }

    const capture = await fixture.app.request(`/hoteles/${hotelBId}/huespedes/${guestBId}/ugc`, {
      method: "POST",
      headers: authB,
      body: JSON.stringify({
        reservationId,
        mediaType: "video",
        mediaReference: "wamid.hotelb-sin-consentimiento",
        granted: false,
        avisoVersion: `aviso-ugc-v1-${Date.now()}`,
      }),
    });
    expect(capture.status).toBe(201);

    const mes = new Date().toISOString().slice(0, 7);
    const res = await fixture.app.request(`/hoteles/${hotelBId}/ugc/calendario?mes=${mes}&postsPorSemana=10`, {
      headers: authB,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicaciones: unknown[]; excluidoPorFaltaDeConsentimiento: number };
    expect(body.publicaciones).toHaveLength(0);
    expect(body.excluidoPorFaltaDeConsentimiento).toBe(1);
  });

  it("un rol sin permiso administrativo no puede consultar el calendario de contenido", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);
    const mes = new Date().toISOString().slice(0, 7);
    const res = await fixture.app.request(`/hoteles/${hotelId}/ugc/calendario?mes=${mes}`, {
      headers: { authorization: `Bearer ${frontdeskToken}` },
    });
    expect(res.status).toBe(403);
  });
});
