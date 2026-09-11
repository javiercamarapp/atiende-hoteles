// REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura de cargos ≥99.5%" (H10-020):
// "El sistema debe lograr una captura de cargos posteados/cheques cerrados a
// habitación superior a un umbral objetivo (p.ej. ≥99.5%), minimizando fuga manual."
//
// La OTRA mitad del mismo REQ (doble verificación de identidad, H10-022) ya está
// cerrada -- ver `ab012-bypass-por-concepto.spec.ts` -- y este archivo NO la toca ni la
// reprueba: los cargos sintéticos de aquí usan concept='hospedaje' (fuera de
// `ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY`) a propósito, para no acoplar el reporte de
// captura con esa regla ya cerrada por separado.
//
// Contra la app real y embedded-postgres (ADR-003) -- nunca contra un mock. Ejercita
// exactamente el criterio de aceptación literal de docs/ACEPTACION.md: "verificado
// sobre un lote de N transacciones sintéticas", con el caso positivo (≥99.5%, cumple)
// Y el caso negativo (por debajo del umbral, no cumple) explícitos.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface HotelCtx {
  hotelId: string;
  roomTypeId: string;
  gmToken: string;
  fnbToken: string;
}

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("REQ-AB-012: reporte de tasa de captura de cargos ≥99.5%", () => {
  let fixture: ApiFixture;
  let hotelA: HotelCtx;
  let hotelB: HotelCtx;
  let accountantTokenA: string;
  // Contador compartido de offset de días para check-in/check-out -- cada folio nuevo
  // (de CUALQUIER hotel) toma un rango distinto para no chocar con disponibilidad.
  let siguienteOffsetDias = 1;

  // Fechas/timestamps de los DOS casos "de lote" (positivo/negativo) se fijan UNA
  // sola vez aquí, antes de que corra cualquier test -- nunca recalculados con
  // `new Date()`/`isoDate()` DENTRO de un test de lote. Motivo real (mismo género de
  // bug que el barrido de "date-rot" reciente de esta suite, ver git log): el lote
  // positivo declara/postea/captura ~600 requests reales contra embedded-postgres, lo
  // que bajo carga de máquina puede tardar más de un minuto -- si `diaAyer` para el
  // caso negativo se calculara DESPUÉS de esa espera con `isoDate(-1)` (relativo al
  // reloj de pared en ESE momento), un cruce de medianoche real durante la espera
  // haría que "ayer" del segundo test coincidiera con "hoy" del primero, mezclando los
  // dos lotes en el mismo día y rompiendo el aislamiento entre ambos casos.
  let diaPositivo: string;
  let diaNegativo: string;
  let ocurrioEnPositivo: string;
  let ocurrioEnNegativo: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const seedA = fixture.seed.hotels[0]!;
    const seedB = fixture.seed.hotels[1]!;
    hotelA = {
      hotelId: seedA.id,
      roomTypeId: seedA.roomTypes[0]!.id,
      gmToken: await loginAs(fixture.app, seedA.staff.find((s) => s.role === "gm")!.email),
      fnbToken: await loginAs(fixture.app, seedA.staff.find((s) => s.role === "fnb")!.email),
    };
    hotelB = {
      hotelId: seedB.id,
      roomTypeId: seedB.roomTypes[0]!.id,
      gmToken: await loginAs(fixture.app, seedB.staff.find((s) => s.role === "gm")!.email),
      fnbToken: await loginAs(fixture.app, seedB.staff.find((s) => s.role === "fnb")!.email),
    };
    accountantTokenA = await loginAs(fixture.app, seedA.staff.find((s) => s.role === "accountant")!.email);

    diaPositivo = isoDate(0);
    diaNegativo = isoDate(-1);
    // "Hace 1 minuto" (nunca un timestamp fijo a mediodía UTC de HOY): `diaPositivo`
    // es HOY, y mediodía UTC podría caer en el futuro si `beforeAll` corre antes de esa
    // hora (rechazado por el margen de sesgo de reloj de `validateRoomChargeCaptureAttempt`).
    ocurrioEnPositivo = new Date(Date.now() - 60_000).toISOString();
    // Mediodía UTC de AYER siempre es pasado sin importar la hora actual -- seguro
    // incluso si el lote positivo tarda mucho y esta constante se usa después.
    ocurrioEnNegativo = `${diaNegativo}T12:00:00.000Z`;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function folioNuevo(ctx: HotelCtx): Promise<string> {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    const { folioId } = await crearFolioConfirmado(fixture.app, ctx.gmToken, ctx.hotelId, {
      roomTypeId: ctx.roomTypeId,
      checkInDate,
      checkOutDate,
    });
    return folioId;
  }

  async function declararIntento(ctx: HotelCtx, folioId: string, overrides: Record<string, unknown> = {}) {
    const res = await fixture.app.request(`/hoteles/${ctx.hotelId}/folios/${folioId}/cargos-habitacion/intentos`, {
      method: "POST",
      headers: { ...auth(ctx.fnbToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({
        fuente: "fnb",
        descripcion: "2 cervezas + botana cerradas a la habitación",
        monto: 250,
        ocurrioEn: new Date().toISOString(),
        ...overrides,
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; estado: string; folioId: string };
  }

  async function postearCargoReal(ctx: HotelCtx, folioId: string, monto: number): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${ctx.hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(ctx.gmToken), "idempotency-key": randomUUID() },
      // concept='hospedaje': fuera de ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY, para no
      // acoplar este test con la doble verificación de identidad (REQ-AB-012, otra
      // mitad, ya cerrada por separado).
      body: JSON.stringify({ descripcion: "Cargo real posteado", monto, concepto: "hospedaje" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function capturar(ctx: HotelCtx, folioId: string, intentoId: string, chargeId: string) {
    return fixture.app.request(`/hoteles/${ctx.hotelId}/folios/${folioId}/cargos-habitacion/intentos/${intentoId}/capturar`, {
      method: "POST",
      headers: auth(ctx.gmToken),
      body: JSON.stringify({ chargeId }),
    });
  }

  async function marcarFuga(ctx: HotelCtx, folioId: string, intentoId: string, token: string, motivo: string) {
    return fixture.app.request(`/hoteles/${ctx.hotelId}/folios/${folioId}/cargos-habitacion/intentos/${intentoId}/fuga`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ motivo }),
    });
  }

  async function reporte(ctx: HotelCtx, desde: string, hasta: string, token: string) {
    return fixture.app.request(`/hoteles/${ctx.hotelId}/reportes/captura-cargos?desde=${desde}&hasta=${hasta}`, { headers: auth(token) });
  }

  const MOTIVO_FUGA_DEFAULT = "Consumo confirmado por el mesero, nunca posteado -- se da por perdido";

  it("declara un intento 'pendiente' al cerrar un consumo a la habitación (antes de saber si se postea)", async () => {
    const folioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    expect(intento.estado).toBe("pendiente");
    expect(intento.folioId).toBe(folioId);
  });

  it("vincula el intento a un charge real posteado -> queda 'capturado'", async () => {
    const folioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    const chargeId = await postearCargoReal(hotelA, folioId, 250);

    const res = await capturar(hotelA, folioId, intento.id, chargeId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; chargeId: string };
    expect(body.estado).toBe("capturado");
    expect(body.chargeId).toBe(chargeId);
  });

  it("capturar con un chargeId que no pertenece a este folio se rechaza (404, nunca se vincula a ciegas)", async () => {
    const folioId = await folioNuevo(hotelA);
    const otroFolioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    const chargeDeOtroFolio = await postearCargoReal(hotelA, otroFolioId, 100);

    const res = await capturar(hotelA, folioId, intento.id, chargeDeOtroFolio);
    expect(res.status).toBe(404);
  });

  it("un rol operativo (fnb) NO puede marcar una fuga -- requiere rol administrativo (owner/gm)", async () => {
    const folioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    const res = await marcarFuga(hotelA, folioId, intento.id, hotelA.fnbToken, MOTIVO_FUGA_DEFAULT);
    expect(res.status).toBe(403);
  });

  it("owner/gm SÍ puede marcar una fuga con motivo -- queda 'fuga', nunca vuelve a 'pendiente'", async () => {
    const folioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    const res = await marcarFuga(hotelA, folioId, intento.id, hotelA.gmToken, MOTIVO_FUGA_DEFAULT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; motivoFuga: string };
    expect(body.estado).toBe("fuga");
    expect(body.motivoFuga).toContain("perdido");
  });

  it("un intento ya resuelto no se puede volver a resolver (nunca dos capturas ni capturado+fuga a la vez)", async () => {
    const folioId = await folioNuevo(hotelA);
    const intento = await declararIntento(hotelA, folioId);
    const chargeId = await postearCargoReal(hotelA, folioId, 250);
    const primero = await capturar(hotelA, folioId, intento.id, chargeId);
    expect(primero.status).toBe(200);

    const segundo = await capturar(hotelA, folioId, intento.id, chargeId);
    expect(segundo.status).toBe(409);

    const fugaDespues = await marcarFuga(hotelA, folioId, intento.id, hotelA.gmToken, MOTIVO_FUGA_DEFAULT);
    expect(fugaDespues.status).toBe(409);
  });

  it("resolver un intentoId de OTRO folio vía este folio se rechaza (404, nunca muta datos de otro folio)", async () => {
    const folioX = await folioNuevo(hotelA);
    const folioY = await folioNuevo(hotelA);
    const intentoDeX = await declararIntento(hotelA, folioX);
    const chargeDeY = await postearCargoReal(hotelA, folioY, 100);

    // Se intenta resolver el intento de X pasando la URL de Y -- debe rechazarse sin
    // mutar el intento de X (verificado abajo: sigue 'pendiente' y SÍ se puede
    // resolver normalmente después, por el folio correcto).
    const res = await capturar(hotelA, folioY, intentoDeX.id, chargeDeY);
    expect(res.status).toBe(404);

    const chargeDeX = await postearCargoReal(hotelA, folioX, 250);
    const resOk = await capturar(hotelA, folioX, intentoDeX.id, chargeDeX);
    expect(resOk.status).toBe(200); // el intento de X NUNCA quedó mutado por el intento fallido vía Y
  });

  it("un rol operativo (fnb) NO puede ver el reporte de captura -- restringido a owner/gm/accountant", async () => {
    const res = await reporte(hotelA, isoDate(0), isoDate(0), hotelA.fnbToken);
    expect(res.status).toBe(403);
  });

  it("rechaza un rango con 'desde' posterior a 'hasta'", async () => {
    const res = await reporte(hotelA, isoDate(1), isoDate(0), accountantTokenA);
    expect(res.status).toBe(400);
  });

  it("el reporte respeta el rango [desde, hasta]: un intento fuera de rango no se cuenta", async () => {
    const folioId = await folioNuevo(hotelA);
    await declararIntento(hotelA, folioId, { descripcion: "fuera-de-rango-futuro", ocurrioEn: new Date(Date.now() + 2 * 60 * 1000).toISOString() });

    const anteayer = isoDate(-6);
    const ayer = isoDate(-5);
    const res = await reporte(hotelA, anteayer, ayer, accountantTokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalIntentos: number };
    expect(body.totalIntentos).toBe(0); // ningún intento de HOY cae en un rango que terminó hace 5 días
  });

  // --- Los dos casos "de lote" del criterio de aceptación literal (docs/ACEPTACION.md:
  // "verificado sobre un lote de N transacciones sintéticas") corren en hotelB, cada
  // uno en su PROPIO día (occurredAt explícito), para quedar aislados tanto de los
  // tests de arriba (hotelA) como entre sí (mismo hotel, días distintos) sin necesitar
  // un tercer hotel sembrado. ---

  it("caso positivo del REQ: 199/200 capturados (99.5% exacto) => cumpleUmbral=true", async () => {
    // UN solo folio real para las 200 transacciones sintéticas del lote (nada en el
    // requisito exige un folio distinto por transacción): el criterio de aceptación
    // pide un LOTE de N transacciones, no N reservas -- crear 200 reservas reales vía
    // el flujo completo de disponibilidad/cotización sería carga de infraestructura
    // ajena a lo que este REQ mide, no una necesidad del propio dominio.
    const folioId = await folioNuevo(hotelB);
    for (let i = 0; i < 200; i++) {
      const intento = await declararIntento(hotelB, folioId, { descripcion: `lote-99.5-${i}`, ocurrioEn: ocurrioEnPositivo });
      if (i < 199) {
        const chargeId = await postearCargoReal(hotelB, folioId, 50);
        const res = await capturar(hotelB, folioId, intento.id, chargeId);
        expect(res.status).toBe(200);
      } else {
        const res = await marcarFuga(hotelB, folioId, intento.id, hotelB.gmToken, "Único no capturado del lote de 200 -- caso límite exacto");
        expect(res.status).toBe(200);
      }
    }

    const res = await reporte(hotelB, diaPositivo, diaPositivo, hotelB.gmToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalIntentos: number;
      capturados: number;
      fuga: number;
      tasaCaptura: number;
      umbralObjetivo: number;
      cumpleUmbral: boolean;
    };
    expect(body.totalIntentos).toBe(200);
    expect(body.capturados).toBe(199);
    expect(body.fuga).toBe(1);
    expect(body.tasaCaptura).toBeCloseTo(0.995, 10);
    expect(body.umbralObjetivo).toBe(0.995);
    expect(body.cumpleUmbral).toBe(true); // 99.5% exacto: el umbral es INCLUSIVO (>=)
  }, 180_000);

  it("caso negativo del REQ: una tasa por debajo del umbral se reporta como cumpleUmbral=false, con el detalle de lo no capturado", async () => {
    // Día DISTINTO al caso positivo de arriba (mismo hotelB) -- aislamiento por fecha,
    // sin necesitar un tercer hotel. `diaNegativo`/`ocurrioEnNegativo` se fijaron en
    // `beforeAll`, ANTES del lote positivo -- ver el comentario junto a su declaración
    // sobre por qué recalcularlos aquí (después de una espera potencialmente larga)
    // sería frágil.
    const folioId = await folioNuevo(hotelB); // mismo criterio que el caso positivo: un folio, N transacciones

    for (let i = 0; i < 17; i++) {
      const intento = await declararIntento(hotelB, folioId, { descripcion: `lote-negativo-capturado-${i}`, ocurrioEn: ocurrioEnNegativo });
      const chargeId = await postearCargoReal(hotelB, folioId, 60);
      const res = await capturar(hotelB, folioId, intento.id, chargeId);
      expect(res.status).toBe(200);
    }

    const pendientesYFuga: string[] = [];
    for (let i = 0; i < 3; i++) {
      const intento = await declararIntento(hotelB, folioId, { descripcion: `lote-negativo-sin-capturar-${i}`, ocurrioEn: ocurrioEnNegativo });
      pendientesYFuga.push(intento.id);
    }
    // Dos de los tres quedan explícitamente en 'fuga'; el tercero se deja 'pendiente'
    // a propósito -- el reporte debe contarlo IGUAL como no capturado (ver
    // chargeCaptureReport.ts: 'pendiente' nunca infla la tasa).
    for (const intentoId of pendientesYFuga.slice(0, 2)) {
      const res = await marcarFuga(hotelB, folioId, intentoId, hotelB.gmToken, "Comanda de bar nunca posteada, confirmada como pérdida");
      expect(res.status).toBe(200);
    }

    const res = await reporte(hotelB, diaNegativo, diaNegativo, hotelB.gmToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalIntentos: number;
      capturados: number;
      fuga: number;
      pendientes: number;
      tasaCaptura: number;
      cumpleUmbral: boolean;
      intentosSinCapturar: Array<{ estado: string }>;
    };
    expect(body.totalIntentos).toBe(20);
    expect(body.capturados).toBe(17);
    expect(body.fuga).toBe(2);
    expect(body.pendientes).toBe(1);
    expect(body.tasaCaptura).toBeCloseTo(0.85, 10);
    expect(body.cumpleUmbral).toBe(false); // el caso negativo real que REQ-AB-012 exige poder detectar
    expect(body.intentosSinCapturar).toHaveLength(3);
  }, 60_000);
});
