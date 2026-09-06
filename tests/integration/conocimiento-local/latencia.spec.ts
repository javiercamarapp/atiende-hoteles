// REQ-UX-005/REQ-HUE-026: "el panel del gerente permite actualizar el conocimiento
// local ... reflejado en <30 s en las respuestas del agente conversacional." El
// agente conversacional de WhatsApp/voz no existe todavía en este repo (requiere
// credenciales reales, ver docs/cierre-p0/inventario.md §2) -- esta prueba verifica lo
// que SÍ es real y medible sin esa dependencia: la latencia de la FUENTE DE DATOS que
// ese agente consultaría en vivo (sin caché intermedio), que es estructuralmente
// <30 s (de hecho, milisegundos) porque cada lectura va directo a la fila actual.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("conocimiento local: panel del gerente + latencia de reflejo (REQ-UX-005)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("el gerente crea una entrada y cualquier staff del hotel la ve de inmediato (<30 s, sin caché)", async () => {
    const marcador = `Sargazo alto en playa norte ${randomUUID()}`;

    const crear = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ categoria: "sargazo", titulo: "Alerta de sargazo", contenido: marcador }),
    });
    expect(crear.status).toBe(201);
    const creada = (await crear.json()) as { id: string; contenido: string };
    expect(creada.contenido).toBe(marcador);

    const inicioLectura = Date.now();
    const lectura = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, { headers: auth(housekeepingToken) });
    const latenciaMs = Date.now() - inicioLectura;

    expect(lectura.status).toBe(200);
    const entradas = (await lectura.json()) as { id: string; contenido: string }[];
    expect(entradas.some((e) => e.contenido === marcador)).toBe(true);
    expect(latenciaMs).toBeLessThan(30_000); // criterio de REQ-UX-005/HUE-026 (<30 s)
  });

  it("actualizar una entrada existente se refleja de inmediato en la siguiente lectura", async () => {
    const crear = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ categoria: "ferry", titulo: "Horario de ferry", contenido: "Salidas cada hora, 8am-6pm" }),
    });
    const { id } = (await crear.json()) as { id: string };

    const nuevoContenido = `Salidas canceladas por clima ${randomUUID()}`;
    const inicio = Date.now();
    const actualizar = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local/${id}`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ contenido: nuevoContenido }),
    });
    expect(actualizar.status).toBe(200);

    const lectura = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, { headers: auth(housekeepingToken) });
    const latenciaMs = Date.now() - inicio;
    const entradas = (await lectura.json()) as { id: string; contenido: string }[];
    expect(entradas.find((e) => e.id === id)?.contenido).toBe(nuevoContenido);
    expect(latenciaMs).toBeLessThan(30_000);
  });

  it("housekeeping puede LEER pero no crear/editar (solo owner/gm/frontdesk, REQ-UX-005 'panel del gerente')", async () => {
    const intento = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, {
      method: "POST",
      headers: auth(housekeepingToken),
      body: JSON.stringify({ categoria: "eventos", titulo: "x", contenido: "x" }),
    });
    expect(intento.status).toBe(403);
  });

  it("borrar una entrada la remueve de lecturas subsecuentes", async () => {
    const crear = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ categoria: "otro", titulo: "temporal", contenido: "temporal" }),
    });
    const { id } = (await crear.json()) as { id: string };

    const borrar = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local/${id}`, { method: "DELETE", headers: auth(gmToken) });
    expect(borrar.status).toBe(200);

    const lectura = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, { headers: auth(gmToken) });
    const entradas = (await lectura.json()) as { id: string }[];
    expect(entradas.find((e) => e.id === id)).toBeUndefined();
  });

  it("sin ninguna entrada registrada, el panel devuelve una lista vacía honesta (nunca datos simulados, REQ-UX-002)", async () => {
    const hotelSinEntradas = fixture.seed.hotels[1]!.id;
    const gmOtroHotel = await loginAs(fixture.app, fixture.seed.hotels[1]!.staff.find((s) => s.role === "gm")!.email);
    const lectura = await fixture.app.request(`/hoteles/${hotelSinEntradas}/conocimiento-local`, { headers: auth(gmOtroHotel) });
    expect(lectura.status).toBe(200);
    expect(await lectura.json()).toEqual([]);
  });
});
