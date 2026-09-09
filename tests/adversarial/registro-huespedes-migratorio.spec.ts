// REQ-SEG-016 · "El registro de huéspedes debe cumplir la normativa migratoria y ser
// exportable sin imágenes de documentos, respetando los plazos de retención definidos
// por plaza (...)". Este archivo cubre la parte GENUINAMENTE cerrable con código de esta
// ronda: exportar el registro (nombre/documento/nacionalidad/estancia) para un rango de
// fechas, sin ninguna imagen (garantía ESTRUCTURAL: ni `guest` ni `identity_ref` tienen
// columna de imagen en todo el esquema, ver 0005/0051).
//
// LÍMITE EXPLICITO (parcial, no "hecho" -- ver docs/REQUISITOS.md/docs/BLOQUEOS.md): la
// retención diferenciada "por plaza" (1-5 años de registro, 30-90 días de audio, 30 días
// de IoT, 7-30 días de CCTV, 5 años de CFDI) NO se prueba aquí porque no está construida
// -- depende de una decisión de negocio/legal (qué plazas, qué periodo exacto en cada
// rango) sin ningún campo de jurisdicción en el esquema, y de hardware pendiente
// (audio/IoT/CCTV) que este repo no tiene todavía.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPassportMrz } from "../../packages/domain-hotel/src/mrz.ts";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("adversarial: registro de huéspedes exportable sin imágenes (REQ-SEG-016)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomTypeId: string;

  const mrz = buildPassportMrz({
    countryCode: "MEX",
    surname: "REGISTRO MIGRATORIO",
    givenNames: "PRUEBA",
    documentNumber: "R1234567",
    nationality: "MEX",
    birthDateYyMmDd: "880101",
    sex: "M",
    expiryDateYyMmDd: "310101",
  });

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

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

  async function crearReservaConIdentidad(offset: number): Promise<{ reservationId: string; checkIn: string; checkOut: string }> {
    const checkIn = await seededDate(offset);
    const checkOut = nightAfter(checkIn);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(res.status).toBe(201);
    const { id: reservationId } = (await res.json()) as { id: string };
    const transicion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(transicion.status).toBe(200);

    const identidad = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrz.line1, mrzLine2: mrz.line2 }),
    });
    expect(identidad.status).toBe(201);

    return { reservationId, checkIn, checkOut };
  }

  it("housekeeping NO puede exportar el registro (403) -- solo owner/gm/frontdesk/reservations", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/registro-migratorio?desde=2020-01-01&hasta=2030-01-01`, {
      headers: auth(housekeepingToken),
    });
    expect(res.status).toBe(403);
  });

  it("rechaza un rango de fechas inválido (hasta < desde) con 400", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/registro-migratorio?desde=2026-06-01&hasta=2026-01-01`, {
      headers: auth(gmToken),
    });
    expect(res.status).toBe(400);
  });

  it("exporta el registro con nombre/documento/nacionalidad/estancia, y NUNCA con ningún campo de imagen (estructural)", async () => {
    const { reservationId, checkIn, checkOut } = await crearReservaConIdentidad(1);

    const res = await fixture.app.request(
      `/hoteles/${hotelId}/huespedes/registro-migratorio?desde=${checkIn}&hasta=${checkIn}`,
      { headers: auth(gmToken) },
    );
    expect(res.status).toBe(200);
    const filas = (await res.json()) as Array<Record<string, unknown>>;
    const fila = filas.find((f) => f.reservationId === reservationId);
    expect(fila).toBeTruthy();
    expect(fila).toMatchObject({
      reservationId,
      tipoDocumento: "pasaporte",
      nacionalidad: "MEX",
      checkIn,
      checkOut,
    });
    expect(typeof fila!.ultimos4).toBe("string");
    expect((fila!.ultimos4 as string).length).toBe(4);
    expect(typeof fila!.nombreCompleto).toBe("string");

    // Garantía ESTRUCTURAL "sin imágenes de documentos": ninguna clave del objeto
    // exportado menciona imagen/foto/documentImage, y ningún valor es una data URL de
    // imagen -- no porque esta query lo filtre, sino porque el esquema entero no tiene
    // dónde guardar esos bytes (ver 0005_guest.sql/0051_identity_vault.sql).
    const claves = Object.keys(fila!);
    for (const clave of claves) {
      expect(clave.toLowerCase()).not.toMatch(/imag|foto|photo|scan/);
    }
    for (const valor of Object.values(fila!)) {
      if (typeof valor === "string") {
        expect(valor.startsWith("data:image")).toBe(false);
      }
    }
  });

  it("una reserva con huésped pero SIN documento de identidad registrado igual aparece en el registro (nacionalidad/tipoDocumento null, honesto)", async () => {
    const guestRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ nombre: "Huésped Sin Identidad Registrada" }),
    });
    expect(guestRes.status).toBe(201);
    const { id: guestId } = (await guestRes.json()) as { id: string };

    const checkIn = await seededDate(2);
    const checkOut = nightAfter(checkIn);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(res.status).toBe(201);
    const { id: reservationId } = (await res.json()) as { id: string };

    const registro = await fixture.app.request(
      `/hoteles/${hotelId}/huespedes/registro-migratorio?desde=${checkIn}&hasta=${checkIn}`,
      { headers: auth(gmToken) },
    );
    expect(registro.status).toBe(200);
    const filas = (await registro.json()) as Array<Record<string, unknown>>;
    const fila = filas.find((f) => f.reservationId === reservationId);
    expect(fila).toBeTruthy();
    expect(fila!.nacionalidad).toBeNull();
  });

  it("un rango de fechas que no cubre ninguna reserva devuelve una lista vacía (nunca un error)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/registro-migratorio?desde=2099-01-01&hasta=2099-01-02`, {
      headers: auth(gmToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
