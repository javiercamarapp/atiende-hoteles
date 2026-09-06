// REQ-RES-016: check-in online de un solo uso (formulario web). Cubre lo que la
// versión E2E (tests/e2e/checkin-online.spec.ts, no incluida en este pase -- no se
// tocó ningún .tsx, ver docs/cierre-p0/inventario.md) verificaría a nivel de API real:
// emitir el enlace, completar con MRZ válida, rechazar reintento (un solo uso),
// rechazar MRZ inválida, y rechazar un token vencido/inexistente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPassportMrz } from "../../packages/domain-hotel/src/mrz.ts";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("check-in online de un solo uso (REQ-RES-016)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  const mrz = buildPassportMrz({
    countryCode: "MEX",
    surname: "MORALES DIAZ",
    givenNames: "CARLOS",
    documentNumber: "H9988776",
    nationality: "MEX",
    birthDateYyMmDd: "880720",
    sex: "M",
    expiryDateYyMmDd: "320101",
  });

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  async function seededDate(offset: number): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    return rows[offset]!.date;
  }
  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  async function crearReservacion(offset: number): Promise<string> {
    const checkIn = await seededDate(offset);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: nightAfter(checkIn) }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  function bodyValido() {
    return {
      nombreCompleto: "Carlos Morales Díaz",
      email: "carlos@example.com",
      telefono: "+5215500003000",
      etaEstimada: new Date(Date.now() + 3600_000).toISOString(),
      rfc: "MODC880720XY1",
      firmaDataUrl: "data:image/png;base64,AAAA",
      mrzLine1: mrz.line1,
      mrzLine2: mrz.line2,
      // auditoria-2/legal [ALTO]: consentimiento expreso obligatorio desde
      // checkinOnline.ts (packages/db/migrations/0068_consentimiento_y_arco.sql).
      consentimientoAvisoPrivacidad: true as const,
    };
  }

  it("staff emite el enlace de un solo uso; el formulario público lo lee sin sesión", async () => {
    const reservationId = await crearReservacion(0);
    const emitir = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link`, {
      method: "POST",
      headers: auth(),
    });
    expect(emitir.status).toBe(201);
    const { token } = (await emitir.json()) as { token: string };

    const lectura = await fixture.app.request(`/checkin-publico/${token}`);
    expect(lectura.status).toBe(200);
    const info = (await lectura.json()) as { hotel: string; checkIn: string };
    expect(info.hotel).toBeTruthy();
    expect(info.checkIn).toBeTruthy();
  });

  it("completar con MRZ válida registra identidad + submission; un SEGUNDO intento con el MISMO token es rechazado", async () => {
    const reservationId = await crearReservacion(1);
    const emitir = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link`, { method: "POST", headers: auth() });
    const { token } = (await emitir.json()) as { token: string };

    const primero = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyValido()),
    });
    expect(primero.status).toBe(201);
    const { reservationId: resDevuelta } = (await primero.json()) as { reservationId: string };
    expect(resDevuelta).toBe(reservationId);

    // La identidad quedó registrada reutilizando REQ-REC-011 (identity_ref con solo
    // campos mínimos), y el guest se actualizó.
    const { rows: refRows } = await fixture.engine.admin.query<{ full_name: string; document_last4: string }>(
      "select full_name, document_last4 from public.identity_ref where reservation_id = $1;",
      [reservationId],
    );
    expect(refRows).toHaveLength(1);
    expect(refRows[0]!.document_last4).toBe("8776");

    const segundo = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyValido()),
    });
    expect(segundo.status).toBe(409); // de un solo uso: el mismo token no puede reutilizarse.

    // Y NO se creó un segundo documento de identidad para la misma reserva.
    const { rows: refsDespues } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_ref where reservation_id = $1;",
      [reservationId],
    );
    expect(refsDespues[0]!.count).toBe("1");
  });

  it("MRZ inválida (dígito de control alterado) es rechazada; el token sigue pendiente para reintentar", async () => {
    const reservationId = await crearReservacion(2);
    const emitir = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link`, { method: "POST", headers: auth() });
    const { token } = (await emitir.json()) as { token: string };

    const mrzAlterada = { ...bodyValido(), mrzLine2: "X" + mrz.line2.slice(1) };
    const intento = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mrzAlterada),
    });
    expect(intento.status).toBe(400);

    // El enlace NO se consumió -- el huésped puede reintentar con una foto legible.
    const lectura = await fixture.app.request(`/checkin-publico/${token}`);
    expect(lectura.status).toBe(200);

    const reintento = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyValido()),
    });
    expect(reintento.status).toBe(201);
  });

  it("un token inexistente devuelve 404, nunca revela información de otra reserva", async () => {
    const res = await fixture.app.request("/checkin-publico/token-que-no-existe");
    expect(res.status).toBe(404);
  });

  it("emitir un nuevo enlace invalida el pendiente anterior de la misma reserva", async () => {
    const reservationId = await crearReservacion(3);
    const primero = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link`, { method: "POST", headers: auth() });
    const { token: tokenViejo } = (await primero.json()) as { token: string };

    const segundo = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link`, { method: "POST", headers: auth() });
    expect(segundo.status).toBe(201);

    const lecturaViejo = await fixture.app.request(`/checkin-publico/${tokenViejo}`);
    expect(lecturaViejo.status).toBe(409); // ya no está "pendiente" (expirado por el nuevo).
  });
});
