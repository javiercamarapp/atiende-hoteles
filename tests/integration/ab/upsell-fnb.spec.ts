// REQ-AB-014 (P2/F, H10-010): "El sistema debe disparar ofertas de upsell F&B (cena
// romántica, botella, desayuno en cama) en momentos definidos (T-7, T-3, check-in),
// con el precio siempre proveniente del motor de Revenue (verificado: 0 precios
// generados por el LLM en la prueba)."
// Contra la app real y embedded-postgres (ADR-003) -- nunca contra un mock: crea
// platillos reales, plantillas de upsell, reservas reales por la API, dispara la
// evaluación real (mismo motor que corre el planificador de `jobs/fnbUpsellScheduler.ts`)
// y verifica el precio ofertado persistido contra el precio real del catálogo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface PlantillaBody {
  id: string;
  tipoOferta: string;
  menuItemId: string;
  precioVigente: number;
  activa: boolean;
}

interface EvaluarBody {
  reservationId: string;
  disparadas: { eventId: string; templateId: string; tipoOferta: string; momento: string; precioOfertado: number; yaExistia: boolean }[];
}

describe("REQ-AB-014: upsell F&B disparado en T-7/T-3/check-in, precio siempre del catálogo real (motor de Revenue)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let fnbToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let otroHotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    hotelId = hotelA.id;
    otroHotelId = hotelB.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    fnbToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "fnb")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  let cenaItemId: string;
  let botellaItemId: string;
  let cenaTemplateId: string;
  let botellaTemplateId: string;

  it("crea los 2 platillos reales que respaldan las ofertas de upsell (REQ-AB-001)", async () => {
    const resCena = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ nombre: "Cena romántica junto al mar", videoUrl: "https://cdn.demo.com/cena.mp4", precio: 1500 }),
    });
    expect(resCena.status).toBe(201);
    cenaItemId = ((await resCena.json()) as { id: string }).id;

    const resBotella = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ nombre: "Botella de espumoso", videoUrl: "https://cdn.demo.com/botella.mp4", precio: 800 }),
    });
    expect(resBotella.status).toBe(201);
    botellaItemId = ((await resBotella.json()) as { id: string }).id;
  });

  it("owner/gm/fnb da de alta las plantillas de upsell -- el precio SIEMPRE es el del platillo real, nunca uno enviado en el body (0 precios del LLM)", async () => {
    const resCena = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/plantillas`, {
      method: "POST",
      headers: auth(fnbToken),
      // Simula un canal conversacional/LLM que intenta inyectar su propio precio --
      // `crearPlantillaSchema` ni siquiera declara un campo `precio`, así que zod lo
      // descarta antes de llegar a la base.
      body: JSON.stringify({ tipoOferta: "cena_romantica", menuItemId: cenaItemId, precio: 1 }),
    });
    expect(resCena.status).toBe(201);
    const cenaBody = (await resCena.json()) as PlantillaBody;
    cenaTemplateId = cenaBody.id;
    expect(cenaBody.precioVigente).toBe(1500); // el precio REAL del menu_item, no "1"

    const resBotella = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/plantillas`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ tipoOferta: "botella", menuItemId: botellaItemId }),
    });
    expect(resBotella.status).toBe(201);
    const botellaBody = (await resBotella.json()) as PlantillaBody;
    botellaTemplateId = botellaBody.id;
    expect(botellaBody.precioVigente).toBe(800);
  });

  it("frontdesk NO puede dar de alta una plantilla de upsell (caso negativo de rol)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/plantillas`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ tipoOferta: "botella", menuItemId: botellaItemId }),
    });
    expect(res.status).toBe(403);
  });

  it("rechaza una plantilla cuyo menu_item pertenece a OTRO hotel (caso negativo de aislamiento entre hoteles)", async () => {
    const gmOtroHotelToken = await loginAs(fixture.app, fixture.seed.hotels[1]!.staff.find((s) => s.role === "gm")!.email);
    const resItemOtroHotel = await fixture.app.request(`/hoteles/${otroHotelId}/menu-items`, {
      method: "POST",
      headers: auth(gmOtroHotelToken),
      body: JSON.stringify({ nombre: "Platillo de otro hotel", videoUrl: "https://cdn.demo.com/x.mp4", precio: 999 }),
    });
    expect(resItemOtroHotel.status).toBe(201);
    const itemOtroHotelId = ((await resItemOtroHotel.json()) as { id: string }).id;

    const res = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/plantillas`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ tipoOferta: "desayuno_en_cama", menuItemId: itemOtroHotelId }),
    });
    expect(res.status).toBe(400);
  });

  let reservationT7: string;
  let reservationLejana: string;
  let reservationCheckinHoy: string;

  it("crea 3 reservas confirmadas reales: una a T-7 exacto, una lejana (nada vencido), una el día de check-in", async () => {
    const t7 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDateOffset(7),
      checkOutDate: isoDateOffset(9),
    });
    reservationT7 = t7.reservationId;

    const lejana = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDateOffset(20),
      checkOutDate: isoDateOffset(22),
    });
    reservationLejana = lejana.reservationId;

    const hoy = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDateOffset(0),
      checkOutDate: isoDateOffset(2),
    });
    reservationCheckinHoy = hoy.reservationId;
  });

  it("una reserva lejana (20 días) no dispara ninguna oferta todavía (caso negativo)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationLejana}/upsell-fnb/evaluar`, {
      method: "POST",
      headers: auth(fnbToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvaluarBody;
    expect(body.disparadas).toHaveLength(0);
  });

  it("dispara T-7 para la reserva a 7 días: 1 oferta por plantilla activa, con el precio REAL del catálogo", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationT7}/upsell-fnb/evaluar`, {
      method: "POST",
      headers: auth(fnbToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvaluarBody;
    expect(body.disparadas).toHaveLength(2);
    expect(body.disparadas.every((d) => d.momento === "t_menos_7")).toBe(true);
    expect(body.disparadas.every((d) => d.yaExistia === false)).toBe(true);

    const cena = body.disparadas.find((d) => d.templateId === cenaTemplateId)!;
    const botella = body.disparadas.find((d) => d.templateId === botellaTemplateId)!;
    expect(cena.precioOfertado).toBe(1500);
    expect(botella.precioOfertado).toBe(800);
  });

  it("volver a evaluar la MISMA reserva no dispara nada NUEVO (T-7 ya no está pendiente) -- 0 filas nuevas, nunca un duplicado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationT7}/upsell-fnb/evaluar`, {
      method: "POST",
      headers: auth(fnbToken),
    });
    const body = (await res.json()) as EvaluarBody;
    // dueUpsellTriggerMoments ya excluye T-7 (visto en `already`), así que ni siquiera
    // vuelve a llamar a `trigger_fnb_upsell_offer` -- 0 disparos nuevos, mismo
    // resultado observable ("nunca un duplicado") sin el round-trip de más.
    expect(body.disparadas).toHaveLength(0);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.fnb_upsell_trigger_event where reservation_id = $1;",
      [reservationT7],
    );
    expect(Number(rows[0]!.count)).toBe(2); // sigue en 2 -- ningún duplicado insertado
  });

  it("`public.trigger_fnb_upsell_offer` es idempotente A NIVEL DE BASE DE DATOS: dos llamadas concurrentes/repetidas del MISMO (reserva, plantilla, momento) nunca insertan dos filas, y la segunda devuelve `ya_disparada: true` con el MISMO precio", async () => {
    const params = [reservationT7, cenaTemplateId, "t_menos_7"];
    const primera = await fixture.engine.admin.query<{ id: string; offered_price: string; ya_disparada: boolean }>(
      "select id, offered_price::text as offered_price, ya_disparada from public.trigger_fnb_upsell_offer($1, $2, $3);",
      params,
    );
    const segunda = await fixture.engine.admin.query<{ id: string; offered_price: string; ya_disparada: boolean }>(
      "select id, offered_price::text as offered_price, ya_disparada from public.trigger_fnb_upsell_offer($1, $2, $3);",
      params,
    );
    // Ambas apuntan al MISMO evento ya creado en el test anterior (T-7 de cenaTemplateId).
    expect(primera.rows[0]!.ya_disparada).toBe(true);
    expect(segunda.rows[0]!.ya_disparada).toBe(true);
    expect(segunda.rows[0]!.id).toBe(primera.rows[0]!.id);
    expect(segunda.rows[0]!.offered_price).toBe(primera.rows[0]!.offered_price);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.fnb_upsell_trigger_event where reservation_id = $1 and template_id = $2 and trigger_moment = $3;",
      params,
    );
    expect(Number(rows[0]!.count)).toBe(1); // nunca 2, pase lo que pase con cuántas veces se llame
  });

  it("el precio ofertado SIEMPRE refleja el catálogo VIGENTE, no uno congelado al crear la plantilla -- el gerente sube el precio de la cena y la siguiente reserva ya ofrece el precio nuevo", async () => {
    await fixture.engine.admin.query("update public.menu_item set price = 1750 where id = $1;", [cenaItemId]);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationCheckinHoy}/upsell-fnb/evaluar`, {
      method: "POST",
      headers: auth(fnbToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvaluarBody;
    // El día de check-in ya venció T-7, T-3 y check-in a la vez (alcance correcto) --
    // 3 momentos x 2 plantillas = 6 ofertas.
    expect(body.disparadas).toHaveLength(6);
    expect(new Set(body.disparadas.map((d) => d.momento))).toEqual(new Set(["t_menos_7", "t_menos_3", "checkin"]));

    const cenaEventos = body.disparadas.filter((d) => d.templateId === cenaTemplateId);
    expect(cenaEventos).toHaveLength(3);
    for (const evento of cenaEventos) {
      expect(evento.precioOfertado).toBe(1750); // el precio NUEVO, nunca el 1500 original
    }
    const botellaEventos = body.disparadas.filter((d) => d.templateId === botellaTemplateId);
    for (const evento of botellaEventos) {
      expect(evento.precioOfertado).toBe(800); // sin tocar, sigue el real
    }
  });

  it("frontdesk NO puede disparar la evaluación manual (caso negativo de rol)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationLejana}/upsell-fnb/evaluar`, {
      method: "POST",
      headers: auth(frontdeskToken),
    });
    expect(res.status).toBe(403);
  });

  it("GET /upsell-fnb/eventos lista lo disparado, filtrable por reserva -- evidencia auditable de lo ya ofertado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/eventos?reservationId=${reservationT7}`, {
      headers: auth(gmToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reservationId: string; momento: string; precioOfertado: number }[];
    expect(body).toHaveLength(2);
    expect(body.every((e) => e.reservationId === reservationT7)).toBe(true);

    const resTodos = await fixture.app.request(`/hoteles/${hotelId}/upsell-fnb/eventos`, { headers: auth(gmToken) });
    const todos = (await resTodos.json()) as unknown[];
    // 2 (T-7) + 6 (check-in hoy) = 8 en total para este hotel.
    expect(todos).toHaveLength(8);
  });

  it("H10-010 'el sistema debe disparar... automáticamente': el planificador en proceso (evaluateAndTriggerFnbUpsellOffers, el mismo motor de jobs/fnbUpsellScheduler.ts) dispara SIN ninguna llamada HTTP manual, y es idempotente frente a lo ya disparado antes", async () => {
    // Una reserva nueva a T-3, nunca tocada por la ruta manual /evaluar -- si el
    // planificador automático de verdad funciona, la dispara por sí solo.
    const t3 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: isoDateOffset(3),
      checkOutDate: isoDateOffset(5),
    });

    const { rows: antes } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.fnb_upsell_trigger_event where reservation_id = $1;",
      [t3.reservationId],
    );
    expect(Number(antes[0]!.count)).toBe(0);

    const { evaluateAndTriggerFnbUpsellOffers } = await import("../../../apps/api/src/jobs/fnbUpsellOffers.ts");
    const result = await evaluateAndTriggerFnbUpsellOffers(fixture.engine.admin, { hotelId, tenantId: fixture.seed.hotels[0]!.id });

    const nuevos = result.triggered.filter((t) => t.reservationId === t3.reservationId);
    // T-7 y T-3 ya vencidos a 3 días, check-in todavía no -- 2 momentos x 2 plantillas.
    expect(nuevos).toHaveLength(4);
    expect(nuevos.every((t) => t.yaDisparada === false)).toBe(true);
    expect(new Set(nuevos.map((t) => t.triggerMoment))).toEqual(new Set(["t_menos_7", "t_menos_3"]));
    expect(nuevos.find((t) => t.templateId === cenaTemplateId)!.offeredPrice).toBe(1750);
    expect(nuevos.find((t) => t.templateId === botellaTemplateId)!.offeredPrice).toBe(800);

    // Correr el planificador una SEGUNDA vez, ahora sí, no debe duplicar nada de lo ya
    // disparado (ni lo manual de antes ni lo automático de recién).
    const segundaVuelta = await evaluateAndTriggerFnbUpsellOffers(fixture.engine.admin, { hotelId, tenantId: fixture.seed.hotels[0]!.id });
    expect(segundaVuelta.triggered).toHaveLength(0);

    const { rows: despues } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.fnb_upsell_trigger_event where hotel_id = $1;",
      [hotelId],
    );
    expect(Number(despues[0]!.count)).toBe(8 + 4); // 8 de antes + 4 nuevos, ni uno más
  });
});
