// REQ-AB-003 (P1/F): "Todo cargo de F&B posteado al folio debe soportar
// reverso/anulación como transacción negativa auditable, con cola offline y
// reconciliación al recuperar conectividad en zonas sin señal (playa/alberca)."
// Contra la app real y embedded-postgres (ADR-003) -- nunca contra un mock.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("REQ-AB-003: cola offline de F&B y reconciliación", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let fnbToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let fnbUserId: string;
  let huespedId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    fnbToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "fnb")!.email);
    fnbUserId = hotelA.staff.find((s) => s.role === "fnb")!.id;

    // Huésped real con apellido/teléfono en archivo, mismo criterio que
    // `ab012-bypass-por-concepto.spec.ts`.
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name, phone) values ($1, $2, $3, $4) returning id;",
      [fixture.seed.orgId, hotelId, "Laura Sánchez Ruiz", "8871234567"],
    );
    huespedId = rows[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }
  async function folioConHuesped() {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    const { folioId, reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate, checkOutDate });
    await fixture.engine.admin.query("update public.reservation set guest_id = $1 where id = $2;", [huespedId, reservationId]);
    return { folioId };
  }

  function offlineCargoBody(folioId: string, overrides: Record<string, unknown> = {}) {
    return {
      operationType: "cargo",
      folioId,
      descripcion: "2 cervezas + botana en playa",
      monto: 250,
      capturadoPor: fnbUserId,
      // Capturado "hace 40 minutos" -- simula el tiempo real sin señal en playa antes
      // de reconciliar al volver a tener conectividad.
      capturadoOfflineEn: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      deviceId: "tablet-playa-07",
      // `loadFolioGuestIdentity` toma el APELLIDO como la última palabra de
      // `full_name` ("Laura Sánchez Ruiz" -> "Ruiz"), mismo criterio que
      // `ab012-bypass-por-concepto.spec.ts`.
      verificacionIdentidad: { apellido: "Ruiz", telefonoUlt4: "4567" },
      ...overrides,
    };
  }

  // Actor realista: el/la mesero(a) (rol 'fnb', NO admin) es quien sincroniza su
  // dispositivo offline -- mismo criterio que `ab012-bypass-por-concepto.spec.ts`
  // para no confundir "verificación de identidad del huésped" con "el actor de la
  // petición ya es admin" (owner/gm sí puede autorizar la excepción, ver
  // `assertRoomChargeIdentityVerified`, pero eso es un escenario aparte).
  async function reconciliar(body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return fixture.app.request(`/hoteles/${hotelId}/fnb-offline-queue/reconciliar`, {
      method: "POST",
      headers: { ...auth(fnbToken), "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  }

  it("reconcilia un 'cargo' offline válido: crea el charge real ('ab') y queda 'aplicado'", async () => {
    const { folioId } = await folioConHuesped();
    const res = await reconciliar(offlineCargoBody(folioId));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resultado: string; chargeId: string | null };
    expect(body.resultado).toBe("aplicado");
    expect(body.chargeId).not.toBeNull();

    const folioRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth(gmToken) });
    const folioBody = (await folioRes.json()) as { cargos: Array<{ id: string; concepto: string }> };
    expect(folioBody.cargos.some((c) => c.id === body.chargeId && c.concepto === "ab")).toBe(true);
  });

  it("reintentar el MISMO Idempotency-Key (misma operación offline reenviada) NO duplica el cargo", async () => {
    const { folioId } = await folioConHuesped();
    const key = randomUUID();
    // Mismo cuerpo EXACTO en ambas llamadas -- un reintento real del dispositivo
    // reenvía el mismo payload que ya tenía en su cola local, nunca uno recalculado.
    const body = offlineCargoBody(folioId);
    const first = await reconciliar(body, key);
    const second = await reconciliar(body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { chargeId: string };
    const secondBody = (await second.json()) as { chargeId: string };
    expect(secondBody.chargeId).toBe(firstBody.chargeId); // misma respuesta cacheada, ningún charge nuevo

    const folioRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth(gmToken) });
    const folioBody = (await folioRes.json()) as { cargos: unknown[] };
    expect(folioBody.cargos.length).toBe(1); // NUNCA 2
  });

  it("un 'cargo' offline SIN verificacionIdentidad se reconcilia como 'rechazado' (nunca se pierde en silencio)", async () => {
    const { folioId } = await folioConHuesped();
    const res = await reconciliar(offlineCargoBody(folioId, { verificacionIdentidad: undefined }));
    expect(res.status).toBe(201); // la RECONCILIACIÓN en sí fue exitosa
    const body = (await res.json()) as { resultado: string; chargeId: string | null; motivoRechazo: string | null };
    expect(body.resultado).toBe("rechazado");
    expect(body.chargeId).toBeNull();
    expect(body.motivoRechazo).toContain("apellido+teléfono");

    const folioRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth(gmToken) });
    const folioBody = (await folioRes.json()) as { cargos: unknown[] };
    expect(folioBody.cargos.length).toBe(0); // ningún cargo fantasma
  });

  it("un 'cargo' offline con apellido que NO coincide se rechaza (REQ-AB-012 aplica igual offline)", async () => {
    const { folioId } = await folioConHuesped();
    const res = await reconciliar(offlineCargoBody(folioId, { verificacionIdentidad: { apellido: "Otro", telefonoUlt4: "4567" } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resultado: string; motivoRechazo: string | null };
    expect(body.resultado).toBe("rechazado");
    expect(body.motivoRechazo).toContain("discrepancia activa");
  });

  it("un ítem con capturedOfflineAt en el futuro se rechaza por el guard de forma (nunca se aplica)", async () => {
    const { folioId } = await folioConHuesped();
    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await reconciliar(offlineCargoBody(folioId, { capturadoOfflineEn: futuro }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resultado: string; motivoRechazo: string | null };
    expect(body.resultado).toBe("rechazado");
    expect(body.motivoRechazo).toContain("futuro");
  });

  it("reconcilia un 'reverso' offline de un cargo real: transacción negativa auditable, nunca borra la original", async () => {
    const { folioId } = await folioConHuesped();
    const cargoRes = await reconciliar(offlineCargoBody(folioId));
    const { chargeId } = (await cargoRes.json()) as { chargeId: string };

    const reversoRes = await reconciliar({
      operationType: "reverso",
      folioId,
      originalChargeId: chargeId,
      descripcion: "Reverso: se cobró dos veces",
      monto: 250,
      capturadoPor: fnbUserId,
      capturadoOfflineEn: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      deviceId: "tablet-playa-07",
      motivoReverso: "Cobro duplicado detectado al reconciliar",
    });
    expect(reversoRes.status).toBe(201);
    const reversoBody = (await reversoRes.json()) as { resultado: string; chargeId: string | null };
    expect(reversoBody.resultado).toBe("aplicado");
    expect(reversoBody.chargeId).not.toBeNull();

    const folioRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth(gmToken) });
    const folioBody = (await folioRes.json()) as { cargos: Array<{ id: string; concepto: string; revertidoPor: string | null }>; saldo: number };
    expect(folioBody.cargos.length).toBe(2); // original + reverso, NUNCA borrado
    expect(folioBody.cargos.find((c) => c.id === chargeId)!.revertidoPor).not.toBeNull();
    expect(folioBody.saldo).toBe(0);
  });

  it("reversar un cargo inexistente vía la cola offline se reconcilia como 'rechazado'", async () => {
    const { folioId } = await folioConHuesped();
    const res = await reconciliar({
      operationType: "reverso",
      folioId,
      originalChargeId: randomUUID(),
      descripcion: "Reverso de algo que no existe",
      monto: 100,
      capturadoPor: fnbUserId,
      capturadoOfflineEn: new Date().toISOString(),
      deviceId: "tablet-playa-07",
      motivoReverso: "Prueba",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resultado: string };
    expect(body.resultado).toBe("rechazado");
  });

  it("GET /fnb-offline-queue lista los ítems reconciliados del hotel (aplicados y rechazados)", async () => {
    const { folioId } = await folioConHuesped();
    await reconciliar(offlineCargoBody(folioId));
    await reconciliar(offlineCargoBody(folioId, { verificacionIdentidad: undefined }));

    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb-offline-queue`, { headers: auth(gmToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ resultado: string }>;
    expect(body.some((i) => i.resultado === "aplicado")).toBe(true);
    expect(body.some((i) => i.resultado === "rechazado")).toBe(true);
  });
});
