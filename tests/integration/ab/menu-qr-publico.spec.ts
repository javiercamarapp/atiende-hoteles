// REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
// alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
// multilingües, y numeración física única por ubicación codificada en el QR."
// Contra la app real y embedded-postgres (ADR-003) -- nunca contra un mock: crea
// platillos y ubicaciones de QR vía la API de staff, y lee el menú por la ruta pública
// exactamente como lo haría un huésped que escaneó el QR (sin token de sesión).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface MenuItemPublico {
  id: string;
  name: string;
  precioAPagar: number;
  incluidoEnPlan: boolean;
  alergenos: { codigo: string; etiqueta: string }[];
}

describe("REQ-AB-001: menú QR con video, reglas de all-inclusive/day-pass y alérgenos multilingües", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let fnbToken: string;
  let frontdeskToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
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

  it("owner/gm/fnb puede dar de alta un platillo con video, precio, reglas y alérgenos", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({
        nombre: "Ceviche de la casa",
        descripcion: "Pescado fresco del día con limón y cilantro",
        videoUrl: "https://cdn.demo.com/ceviche.mp4",
        precio: 180,
        incluidoEnTodoIncluido: true,
        disponibleDayPass: true,
        recargoDayPass: 40,
        alergenos: ["pescado", "mariscos"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; videoUrl: string; alergenos: string[] };
    expect(body.videoUrl).toBe("https://cdn.demo.com/ceviche.mp4");
    expect(body.alergenos).toEqual(["pescado", "mariscos"]);
  });

  it("frontdesk NO puede dar de alta un platillo (caso negativo de rol)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({
        nombre: "Intento no autorizado",
        videoUrl: "https://cdn.demo.com/x.mp4",
        precio: 100,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rechaza un platillo sin video (el REQ es 'menú QR CON VIDEO', nunca opcional)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ nombre: "Sin video", precio: 50 }),
    });
    expect(res.status).toBe(400);
  });

  it("rechaza un alérgeno fuera del catálogo cerrado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({
        nombre: "Platillo con alérgeno inventado",
        videoUrl: "https://cdn.demo.com/x.mp4",
        precio: 50,
        alergenos: ["kriptonita"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("da de alta un segundo platillo NO incluido en todo-incluido y NO disponible para day-pass", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({
        nombre: "Corte premium",
        videoUrl: "https://cdn.demo.com/corte.mp4",
        precio: 650,
        incluidoEnTodoIncluido: false,
        disponibleDayPass: false,
      }),
    });
    expect(res.status).toBe(201);
  });

  let locationCodeMesa1: string;
  let locationCodeCamastro1: string;

  it("registra dos ubicaciones físicas de QR y verifica: 2 QR distintos -> 2 location_code distintos", async () => {
    const resMesa = await fixture.app.request(`/hoteles/${hotelId}/menu-qr/ubicaciones`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ tipoUbicacion: "mesa", numeroFisico: 1 }),
    });
    expect(resMesa.status).toBe(201);
    const mesaBody = (await resMesa.json()) as { locationCode: string; qrTargetUrl: string };
    locationCodeMesa1 = mesaBody.locationCode;
    expect(mesaBody.qrTargetUrl).toContain(`/menu/${locationCodeMesa1}`);

    const resCamastro = await fixture.app.request(`/hoteles/${hotelId}/menu-qr/ubicaciones`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ tipoUbicacion: "camastro", numeroFisico: 1 }),
    });
    expect(resCamastro.status).toBe(201);
    const camastroBody = (await resCamastro.json()) as { locationCode: string };
    locationCodeCamastro1 = camastroBody.locationCode;

    expect(locationCodeMesa1).not.toBe(locationCodeCamastro1);
  });

  it("registra las 5 ubicaciones que el REQ exige (habitación/alberca/camastro/playa/mesa) sin colisión", async () => {
    const tipos = ["habitacion", "alberca", "camastro", "playa", "mesa"] as const;
    const codigos = new Set<string>();
    for (const tipo of tipos) {
      const res = await fixture.app.request(`/hoteles/${hotelId}/menu-qr/ubicaciones`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ tipoUbicacion: tipo, numeroFisico: 99 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { locationCode: string; tipoUbicacion: string };
      expect(body.tipoUbicacion).toBe(tipo);
      codigos.add(body.locationCode);
    }
    expect(codigos.size).toBe(tipos.length);
  });

  it("rechaza registrar dos veces la MISMA numeración física para el MISMO tipo (caso negativo de duplicado)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/menu-qr/ubicaciones`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ tipoUbicacion: "mesa", numeroFisico: 1 }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /menu/:locationCode público (SIN token) devuelve el catálogo completo con tarifa 'ninguno' por defecto", async () => {
    const res = await fixture.app.request(`/menu/${locationCodeMesa1}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tipoUbicacion: string; numeroFisico: number; items: MenuItemPublico[] };
    expect(body.tipoUbicacion).toBe("mesa");
    expect(body.numeroFisico).toBe(1);
    expect(body.items).toHaveLength(2);
    const ceviche = body.items.find((i) => i.name === "Ceviche de la casa")!;
    const corte = body.items.find((i) => i.name === "Corte premium")!;
    expect(ceviche.precioAPagar).toBe(180);
    expect(corte.precioAPagar).toBe(650);
  });

  it("aplica la regla de todo-incluido: el platillo incluido cuesta 0, el premium se paga completo", async () => {
    const res = await fixture.app.request(`/menu/${locationCodeCamastro1}?tarifa=all_inclusive`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: MenuItemPublico[] };
    const ceviche = body.items.find((i) => i.name === "Ceviche de la casa")!;
    const corte = body.items.find((i) => i.name === "Corte premium")!;
    expect(ceviche.precioAPagar).toBe(0);
    expect(ceviche.incluidoEnPlan).toBe(true);
    expect(corte.precioAPagar).toBe(650);
    expect(corte.incluidoEnPlan).toBe(false);
  });

  it("aplica la regla de day-pass: paga precio+recargo, y el platillo no disponible desaparece del menú (caso negativo)", async () => {
    const res = await fixture.app.request(`/menu/${locationCodeMesa1}?tarifa=day_pass`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: MenuItemPublico[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.name).toBe("Ceviche de la casa");
    expect(body.items[0]!.precioAPagar).toBe(180 + 40);
  });

  it("traduce los alérgenos al idioma pedido (multilingüe, caso inglés y francés)", async () => {
    const resEn = await fixture.app.request(`/menu/${locationCodeMesa1}?idioma=en`);
    const bodyEn = (await resEn.json()) as { items: MenuItemPublico[] };
    const cevicheEn = bodyEn.items.find((i) => i.name === "Ceviche de la casa")!;
    expect(cevicheEn.alergenos.map((a) => a.etiqueta).sort()).toEqual(["Fish", "Shellfish"].sort());

    const resFr = await fixture.app.request(`/menu/${locationCodeMesa1}?idioma=fr`);
    const bodyFr = (await resFr.json()) as { items: MenuItemPublico[] };
    const cevicheFr = bodyFr.items.find((i) => i.name === "Ceviche de la casa")!;
    expect(cevicheFr.alergenos.map((a) => a.etiqueta).sort()).toEqual(["Fruits de mer", "Poisson"].sort());
  });

  it("un location_code inexistente devuelve 404 sin filtrar si el problema es el código o el hotel (caso negativo)", async () => {
    const res = await fixture.app.request("/menu/CODIGO-QUE-NO-EXISTE-0001");
    expect(res.status).toBe(404);
  });

  it("un idioma o tarifa fuera de catálogo se rechaza con 400 (nunca cae silenciosamente a un default fabricado)", async () => {
    const resTarifa = await fixture.app.request(`/menu/${locationCodeMesa1}?tarifa=vip-fantasma`);
    expect(resTarifa.status).toBe(400);
    const resIdioma = await fixture.app.request(`/menu/${locationCodeMesa1}?idioma=klingon`);
    expect(resIdioma.status).toBe(400);
  });
});
