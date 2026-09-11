// REQ-CRM-010 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe capturar
// contenido generado por el huésped (UGC) vía WhatsApp post-estancia con registro
// explícito de consentimiento de uso, y generar un calendario mensual de contenido/
// publicaciones." Contra embedded-postgres real (ADR-003): ejercita las rutas nuevas
// (`apps/api/src/routes/ugc.ts`) -- capturar, listar y validaciones/permisos. El caso
// negativo exacto del criterio de aceptación ("UGC sin consentimiento → 0 uso
// permitido") vive en tests/adversarial/ugc-consentimiento.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface UgcSubmissionResponse {
  id: string;
  guestId: string;
  reservationId: string;
  tipoMedia: string;
  referenciaMedia: string;
  caption: string | null;
  consentimientoOtorgado: boolean;
}

describe("REQ-CRM-010: captura de UGC post-estancia", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let guestId: string;
  let reservationCheckedOutId: string;

  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }
  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);

    const guestRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ nombre: "Huésped UGC Integración" }),
    });
    expect(guestRes.status).toBe(201);
    guestId = ((await guestRes.json()) as { id: string }).id;

    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate, checkOutDate, guestId }),
    });
    expect(created.status).toBe(201);
    reservationCheckedOutId = ((await created.json()) as { id: string }).id;
    for (const toStatus of ["confirmada", "check_in", "en_estancia", "check_out"]) {
      const t = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationCheckedOutId}/transicion`, {
        method: "PATCH",
        headers: auth(gmToken),
        body: JSON.stringify({ toStatus }),
      });
      expect(t.status).toBe(200);
    }
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("POST captura una foto post-estancia con consentimiento otorgado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/ugc`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({
        reservationId: reservationCheckedOutId,
        mediaType: "foto",
        mediaReference: "wamid.integracion-1",
        caption: "En la alberca",
        granted: true,
        avisoVersion: "aviso-ugc-v1",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UgcSubmissionResponse;
    expect(body.guestId).toBe(guestId);
    expect(body.reservationId).toBe(reservationCheckedOutId);
    expect(body.tipoMedia).toBe("foto");
    expect(body.referenciaMedia).toBe("wamid.integracion-1");
    expect(body.caption).toBe("En la alberca");
    expect(body.consentimientoOtorgado).toBe(true);
  });

  it("POST rechaza mediaReference vacía (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/ugc`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({
        reservationId: reservationCheckedOutId,
        mediaType: "foto",
        mediaReference: "",
        granted: true,
        avisoVersion: "aviso-ugc-v1",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST rechaza avisoVersion vacía (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/ugc`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({
        reservationId: reservationCheckedOutId,
        mediaType: "foto",
        mediaReference: "wamid.avisovacio",
        granted: true,
        avisoVersion: "",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST a un huésped inexistente/de otro hotel da 404", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/huespedes/00000000-0000-0000-0000-000000000000/ugc`,
      {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({
          reservationId: reservationCheckedOutId,
          mediaType: "foto",
          mediaReference: "wamid.huespedinexistente",
          granted: true,
          avisoVersion: "aviso-ugc-v1",
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST con una reserva que no pertenece al huésped da 404", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/ugc`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({
        reservationId: "00000000-0000-0000-0000-000000000000",
        mediaType: "foto",
        mediaReference: "wamid.reservainexistente",
        granted: true,
        avisoVersion: "aviso-ugc-v1",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("GET lista lo capturado (owner/gm) incluyendo el estado de consentimiento", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/ugc`, { headers: auth(gmToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submissions: UgcSubmissionResponse[] };
    expect(body.submissions.some((s) => s.referenciaMedia === "wamid.integracion-1" && s.consentimientoOtorgado)).toBe(
      true,
    );
  });

  it("GET listar está restringido a owner/gm", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/ugc`, { headers: { authorization: `Bearer ${frontdeskToken}` } });
    expect(res.status).toBe(403);
  });

  it("GET calendario rechaza un mes con formato inválido (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/ugc/calendario?mes=2026-13`, { headers: auth(gmToken) });
    expect(res.status).toBe(400);
  });
});
