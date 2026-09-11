// REQ-REC-012 estilo/H5 · un rol de dinero SIN privilegio administrativo (frontdesk)
// no puede aplicar un descuento sobre el umbral configurado sin traer la autorización
// verificada de un rol administrativo (owner/gm) -- verificado con: (a) intento sin
// autorización -> 0 descuentos aplicados; (b) intento con un userId que NO es
// admin de este hotel -> también rechazado (nunca se confía en el id a ciegas);
// (c) con autorización real -> permitido.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


describe("adversarial: descuento sobre el umbral requiere autorización real verificada (REQ-REC-012 estilo)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let housekeepingUserId: string;
  let gmUserId: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    housekeepingUserId = hotelA.staff.find((s) => s.role === "housekeeping")!.id;
    gmUserId = hotelA.staff.find((s) => s.role === "gm")!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function nuevoFolio() {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDate(7),
      checkOutDate: isoDate(8),
    });
    return folioId;
  }

  it("(a) frontdesk sin autorización, descuento sobre el umbral: 0 descuentos aplicados", async () => {
    const folioId = await nuevoFolio();
    const before = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1 and concept = 'descuento';",
      [folioId],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Descuento sin autorización", monto: 900 }),
    });
    expect(res.status).toBe(403);

    const after = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1 and concept = 'descuento';",
      [folioId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("(b) traer el userId de HOUSEKEEPING como 'autorizadoPorUserId' NO cuenta como autorización (no es rol administrativo)", async () => {
    const folioId = await nuevoFolio();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Descuento con id inválido", monto: 900, autorizadoPorUserId: housekeepingUserId }),
    });
    expect(res.status).toBe(403);
  });

  it("(c) un userId de gm REAL de este hotel sí autoriza el descuento", async () => {
    const folioId = await nuevoFolio();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Descuento autorizado", monto: 900, autorizadoPorUserId: gmUserId }),
    });
    expect(res.status).toBe(201);
  });

  it("housekeeping no puede ni siquiera intentar aplicar un cargo/descuento (403 por rol, antes de llegar a la RLS)", async () => {
    const folioId = await nuevoFolio();
    const hkToken = await loginAs(fixture.app, fixture.seed.hotels[0]!.staff.find((s) => s.role === "housekeeping")!.email);
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(hkToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Intento housekeeping", monto: 10 }),
    });
    expect(res.status).toBe(403);
  });
});
