// REQ-AB-012 (P1/NF): "...y verificar identidad doblemente al cargar a habitación."
// Contra la app real y embedded-postgres (ADR-003) -- nunca contra un mock.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, crearHuesped, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("REQ-AB-012: doble verificación de identidad al cargar a habitación", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let gmUserId: string;
  let huespedId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    gmUserId = hotelA.staff.find((s) => s.role === "gm")!.id;
    huespedId = (await crearHuesped(fixture.app, gmToken, hotelId, { nombre: "Ana Martínez López", telefono: "5544332211" })).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  // La seed siembra tarifa/disponibilidad para los próximos 30 días reales a partir
  // de "ahora" (no de una fecha fija) -- cada test pide sus propias 2 noches
  // consecutivas, sin solaparse con las demás (mismo patrón que
  // tests/integration/fraude/patrones-internos.spec.ts).
  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }
  function reservarFechas(): { checkInDate: string; checkOutDate: string } {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    return { checkInDate, checkOutDate };
  }
  async function folioConHuesped() {
    return crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, ...reservarFechas(), guestId: huespedId });
  }

  async function postCargoAb(folioId: string, token: string, verificacionIdentidad: Record<string, unknown> | undefined) {
    return fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(token), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Consumo de bar en alberca", monto: 300, concepto: "ab", verificacionIdentidad }),
    });
  }

  it("rechaza un cargo 'ab' que NO trae verificacionIdentidad (400)", async () => {
    const { folioId } = await folioConHuesped();
    const res = await postCargoAb(folioId, gmToken, undefined);
    expect(res.status).toBe(400);
  });

  it("acepta un cargo 'ab' cuando apellido y últimos 4 de teléfono coinciden con el huésped real", async () => {
    const { folioId } = await folioConHuesped();
    const res = await postCargoAb(folioId, gmToken, { apellidoConfirmado: "Martínez", telefonoUltimos4Confirmado: "2211" });
    expect(res.status).toBe(201);
  });

  it("rechaza (409) cuando el apellido declarado NO coincide, aunque el teléfono sí", async () => {
    const { folioId } = await folioConHuesped();
    const res = await postCargoAb(folioId, gmToken, { apellidoConfirmado: "Gómez", telefonoUltimos4Confirmado: "2211" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("conflict");
  });

  it("rechaza (409) cuando los últimos 4 de teléfono NO coinciden, aunque el apellido sí", async () => {
    const { folioId } = await folioConHuesped();
    const res = await postCargoAb(folioId, gmToken, { apellidoConfirmado: "Martínez", telefonoUltimos4Confirmado: "0000" });
    expect(res.status).toBe(409);
  });

  it("una discrepancia activa NUNCA es overridable, ni con autorizadoPorUserId de un gm real", async () => {
    const { folioId } = await folioConHuesped();
    const res = await postCargoAb(folioId, gmToken, {
      apellidoConfirmado: "Gómez",
      telefonoUltimos4Confirmado: "2211",
      autorizadoPorUserId: gmUserId,
    });
    expect(res.status).toBe(409);
  });

  it("folio SIN huésped en archivo: se rechaza por defecto", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, ...reservarFechas() });
    const res = await postCargoAb(folioId, gmToken, { apellidoConfirmado: "Cualquiera", telefonoUltimos4Confirmado: "1234" });
    expect(res.status).toBe(409);
  });

  it("folio SIN huésped en archivo: la válvula de escape administrativa (gm real) SÍ permite postear", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, ...reservarFechas() });
    const res = await postCargoAb(folioId, frontdeskToken, {
      apellidoConfirmado: "N/A",
      telefonoUltimos4Confirmado: "0000",
      autorizadoPorUserId: gmUserId,
    });
    expect(res.status).toBe(201);
  });

  it("un autorizadoPorUserId que NO es owner/gm (fabricado/de otro rol) NO concede la válvula de escape", async () => {
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, ...reservarFechas() });
    const res = await postCargoAb(folioId, frontdeskToken, {
      apellidoConfirmado: "N/A",
      telefonoUltimos4Confirmado: "0000",
      autorizadoPorUserId: randomUUID(), // usuario inexistente
    });
    expect(res.status).toBe(409);
  });

  it("transferir un cargo 'ab' ya verificado a otro folio NO exige re-verificar (la evidencia se copia)", async () => {
    const { folioId: origenId } = await folioConHuesped();
    const { folioId: destinoId } = await folioConHuesped();

    const cargoRes = await postCargoAb(origenId, gmToken, { apellidoConfirmado: "Martínez", telefonoUltimos4Confirmado: "2211" });
    expect(cargoRes.status).toBe(201);
    const { id: chargeId } = (await cargoRes.json()) as { id: string };

    const transferRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${origenId}/cargos/${chargeId}/transferir`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ folioDestinoId: destinoId }),
    });
    expect(transferRes.status).toBe(201);

    const destinoFolio = await fixture.app.request(`/hoteles/${hotelId}/folios/${destinoId}`, { headers: auth(gmToken) });
    const destinoBody = (await destinoFolio.json()) as { cargos: Array<{ concepto: string; identidadVerificadaEn: string | null }> };
    const cargoAb = destinoBody.cargos.find((c) => c.concepto === "ab");
    expect(cargoAb).toBeDefined();
    expect(cargoAb!.identidadVerificadaEn).not.toBeNull();
  });
});
