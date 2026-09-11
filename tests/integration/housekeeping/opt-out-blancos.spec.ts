// REQ-HK-005 · "El sistema debe registrar el opt-out de limpieza/reposición de blancos
// con incentivo (sin culpar al huésped en el mensaje) y contar blancos/amenidades por
// foto contra el consumo teórico, alertando desviaciones." Criterio literal de
// docs/ACEPTACION.md: "Opt-out de limpieza registrado con mensaje sin culpar al
// huésped (verificado por texto del mensaje); consumo de blancos/amenidades contado
// por foto contra consumo teórico, alertando desviación sobre el umbral configurado."
//
// Contra un `embedded-postgres` REAL (migración 0130_housekeeping_linen_opt_out.sql +
// las rutas nuevas de apps/api/src/routes/housekeeping.ts), no mocks -- las mismas dos
// tablas/RLS/guardas de dominio que corren en producción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: opt-out de limpieza + conteo de blancos/amenidades por foto (REQ-HK-005, integración real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let housekeepingToken: string;
  let accountantToken: string;
  let hotelId: string;
  let roomAId: string;
  let roomBId: string;
  let roomCId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
    accountantToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "accountant")!.email);

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room where hotel_id = $1 order by code limit 3;",
      [hotelId],
    );
    roomAId = rows[0]!.id;
    roomBId = rows[1]!.id;
    roomCId = rows[2]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("registra el opt-out con incentivo y un mensaje de confirmación que NO culpa al huésped (verificable por el texto persistido)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomAId}/opt-out-limpieza`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fecha: "2026-09-10", incentivo: "10% de descuento en el spa" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; mensaje: string; incentivo: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.incentivo).toBe("10% de descuento en el spa");
    // El criterio de aceptación exige verificar POR TEXTO que el mensaje no culpa al
    // huésped, y que sí registra el incentivo ofrecido.
    expect(body.mensaje.toLowerCase()).not.toMatch(/culpa|responsable de|te niegas|egoista|egoísta/);
    expect(body.mensaje).toContain("10% de descuento en el spa");

    const { rows } = await fixture.engine.admin.query<{ message_text: string; incentive_description: string }>(
      "select message_text, incentive_description from public.housekeeping_linen_opt_out where id = $1;",
      [body.id],
    );
    expect(rows[0]!.message_text).toBe(body.mensaje);
    expect(rows[0]!.incentive_description).toBe("10% de descuento en el spa");
  });

  it("CASO NEGATIVO: un mensaje personalizado que culpa al huésped se RECHAZA (400) y nunca se persiste", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomBId}/opt-out-limpieza`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({
        fecha: "2026-09-10",
        incentivo: "5% de descuento en restaurante",
        mensaje: "Por tu culpa no se te dará servicio de limpieza hoy.",
      }),
    });
    expect(res.status).toBe(400);

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.housekeeping_linen_opt_out where hotel_id = $1 and room_id = $2 and stay_date = '2026-09-10';",
      [hotelId, roomBId],
    );
    expect(rows.length).toBe(0);
  });

  it("registrar el mismo (habitación, día) dos veces es idempotente -- la segunda vez devuelve el existente con duplicate=true, no lo sobreescribe", async () => {
    const primero = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomBId}/opt-out-limpieza`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ fecha: "2026-09-11", incentivo: "50 puntos de lealtad" }),
    });
    expect(primero.status).toBe(201);
    const { id: idOriginal, mensaje: mensajeOriginal } = (await primero.json()) as { id: string; mensaje: string };

    const segundo = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomBId}/opt-out-limpieza`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ fecha: "2026-09-11", incentivo: "otro incentivo distinto" }),
    });
    expect(segundo.status).toBe(200);
    const segundoBody = (await segundo.json()) as { id: string; mensaje: string; duplicate: boolean };
    expect(segundoBody.duplicate).toBe(true);
    expect(segundoBody.id).toBe(idOriginal);
    expect(segundoBody.mensaje).toBe(mensajeOriginal); // no se sobreescribió con el segundo incentivo

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.housekeeping_linen_opt_out where hotel_id = $1 and room_id = $2 and stay_date = '2026-09-11';",
      [hotelId, roomBId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("GET opt-out-limpieza lista y filtra por habitación/fecha", async () => {
    const lista = await fixture.app.request(
      `/hoteles/${hotelId}/housekeeping/opt-out-limpieza?roomId=${roomAId}&fecha=2026-09-10`,
      { headers: authOf(gmToken) },
    );
    expect(lista.status).toBe(200);
    const items = (await lista.json()) as Array<{ roomId: string; fecha: string }>;
    expect(items.length).toBe(1);
    expect(items[0]!.roomId).toBe(roomAId);
    expect(items[0]!.fecha).toBe("2026-09-10");
  });

  it("CASO NEGATIVO: un rol sin acceso operativo (accountant) no puede registrar un opt-out (403)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomCId}/opt-out-limpieza`, {
      method: "POST",
      headers: authOf(accountantToken),
      body: JSON.stringify({ fecha: "2026-09-10", incentivo: "algo" }),
    });
    expect(res.status).toBe(403);
  });

  it("CASO NEGATIVO: el conteo de blancos/amenidades SIN evidencia de foto se rechaza (400) -- 'verificado por foto' no es opcional", async () => {
    const sinFoto = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomCId}/conteo-blancos`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ tipo: "blancos", contado: 10, teorico: 10 }),
    });
    expect(sinFoto.status).toBe(400);

    const conUrlInvalida = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomCId}/conteo-blancos`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ tipo: "blancos", contado: 10, teorico: 10, fotoUrl: "no-es-una-url" }),
    });
    expect(conUrlInvalida.status).toBe(400);
  });

  it("conteo dentro del consumo teórico (sin desviación relevante): no dispara alerta", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomCId}/conteo-blancos`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({
        tipo: "blancos",
        contado: 20,
        teorico: 20,
        fotoUrl: "https://storage.example.com/evidencia/foto-blancos-1.jpg",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { alerta: boolean; desviacionUnidades: number; desviacionPct: number; umbralPct: number };
    expect(body.alerta).toBe(false);
    expect(body.desviacionUnidades).toBe(0);
    expect(body.desviacionPct).toBe(0);
    expect(body.umbralPct).toBeGreaterThan(0);
  });

  it("conteo con desviación mayor al umbral configurado SÍ dispara alerta, persistida y visible en el reporte filtrado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomCId}/conteo-blancos`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({
        tipo: "amenidades",
        contado: 5,
        teorico: 20,
        fotoUrl: "https://storage.example.com/evidencia/foto-amenidades-1.jpg",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; alerta: boolean; desviacionUnidades: number; desviacionPct: number };
    expect(body.alerta).toBe(true);
    expect(body.desviacionUnidades).toBe(-15);
    expect(body.desviacionPct).toBeCloseTo(75, 5);

    const { rows } = await fixture.engine.admin.query<{ alert_triggered: boolean; photo_evidence_url: string }>(
      "select alert_triggered, photo_evidence_url from public.housekeeping_linen_count where id = $1;",
      [body.id],
    );
    expect(rows[0]!.alert_triggered).toBe(true);
    expect(rows[0]!.photo_evidence_url).toBe("https://storage.example.com/evidencia/foto-amenidades-1.jpg");

    const reporteAlertas = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/conteo-blancos?soloAlertas=true`, {
      headers: authOf(gmToken),
    });
    expect(reporteAlertas.status).toBe(200);
    const alertas = (await reporteAlertas.json()) as Array<{ id: string; alerta: boolean }>;
    expect(alertas.length).toBeGreaterThan(0);
    expect(alertas.every((a) => a.alerta === true)).toBe(true);
    expect(alertas.some((a) => a.id === body.id)).toBe(true);
  });

  it("GET conteo-blancos sin filtro incluye tanto los que alertaron como los que no", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/conteo-blancos`, { headers: authOf(gmToken) });
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ roomId: string; alerta: boolean }>;
    expect(items.some((i) => i.roomId === roomCId && i.alerta === true)).toBe(true);
    expect(items.some((i) => i.roomId === roomCId && i.alerta === false)).toBe(true);
  });
});
