// REQ-AB-011 (docs/REQUISITOS.md/docs/ACEPTACION.md): "Bitácoras digitales
// automatizadas de temperatura/recepción/limpieza conforme a NOM-251, disponibles
// para auditoría COFEPRIS (verificado: exportación con campos exigidos por la
// norma)." Contra embedded-postgres real (ADR-003): ejercita las rutas nuevas
// (apps/api/src/routes/bitacorasNom251.ts) -- captura de los tres tipos de bitácora,
// caso negativo de validación (recepción sin motivo de rechazo), control de acceso
// por rol, inmutabilidad estructural (append-only + cadena de hash, mismo patrón que
// attendance_log/0118) y la exportación CSV con los campos exigidos.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface BitacoraCreada {
  id: string;
  tipo: string;
  payload: Record<string, unknown>;
  registradoEn: string;
  anomalia: boolean;
  motivoAnomalia: string | null;
}

interface BitacoraListada {
  id: string;
  tipo: string;
  registradoPor: string;
  anomalia: boolean;
}

describe("REQ-AB-011: bitácoras NOM-251 (temperatura/recepción/limpieza)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let fnbToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let otherHotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    otherHotelId = fixture.seed.hotels[1]!.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    fnbToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "fnb")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("fnb captura una lectura de temperatura dentro de rango: sin anomalía", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "temperatura",
        payload: { equipo: "Refrigerador cocina 1", tipoEquipo: "refrigeracion", temperaturaC: 3 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BitacoraCreada;
    expect(body.tipo).toBe("temperatura");
    expect(body.anomalia).toBe(false);
  });

  it("fnb captura una lectura de temperatura FUERA de rango: la guarda igual y la marca como anomalía (no la oculta)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "temperatura",
        payload: { equipo: "Refrigerador cocina 1", tipoEquipo: "refrigeracion", temperaturaC: 11 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BitacoraCreada;
    expect(body.payload.temperaturaC).toBe(11); // el valor real, sin corregir
    expect(body.anomalia).toBe(true);
    expect(body.motivoAnomalia).toMatch(/fuera del rango/);
  });

  it("owner captura una recepción de mercancía aceptada", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "recepcion",
        payload: {
          proveedor: "Distribuidora del Caribe",
          producto: "Camarón congelado",
          lote: "L-045",
          temperaturaC: -19,
          empaqueIntegro: true,
          fechaCaducidad: "2026-12-01",
          aceptado: true,
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BitacoraCreada;
    expect(body.tipo).toBe("recepcion");
    expect(body.anomalia).toBe(false);
  });

  it("CASO NEGATIVO: una recepción rechazada SIN motivoRechazo se rechaza con 400 (no se persiste)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "recepcion",
        payload: { proveedor: "P", producto: "Pollo", empaqueIntegro: false, aceptado: false },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("CASO NEGATIVO: una recepción aceptada CON motivoRechazo también se rechaza con 400", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "recepcion",
        payload: { proveedor: "P", producto: "Pollo", empaqueIntegro: true, aceptado: true, motivoRechazo: "no debería aceptarse" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("gm captura una recepción RECHAZADA con motivo: se guarda y se marca como anomalía", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "recepcion",
        payload: { proveedor: "P", producto: "Pollo", empaqueIntegro: false, aceptado: false, motivoRechazo: "Cadena de frío rota" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BitacoraCreada;
    expect(body.anomalia).toBe(true);
    expect(body.motivoAnomalia).toBe("Cadena de frío rota");
  });

  it("fnb captura una bitácora de limpieza", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "limpieza",
        payload: { area: "Cocina caliente", tipoLimpieza: "limpieza_y_desinfeccion", productoUsado: "Amonio cuaternario", concentracionPpm: 200 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BitacoraCreada;
    expect(body.tipo).toBe("limpieza");
  });

  it("housekeeping (rol sin motivo operativo sobre cocina) NO puede capturar una bitácora NOM-251", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${housekeepingToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "limpieza",
        payload: { area: "X", tipoLimpieza: "limpieza", productoUsado: "Jabón" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("no se puede capturar una bitácora en un hotel al que el staff no pertenece", async () => {
    const res = await fixture.app.request(`/hoteles/${otherHotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "limpieza",
        payload: { area: "X", tipoLimpieza: "limpieza", productoUsado: "Jabón" },
      }),
    });
    expect(res.status).toBe(403); // requireHotelMembership: fnb no pertenece a otherHotelId
  });

  it("SIEMPRE registra a quien capturó la sesión real, nunca un id que el cliente mande en el body", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        tipo: "limpieza",
        payload: { area: "Barra", tipoLimpieza: "limpieza", productoUsado: "Agua y jabón" },
        // Un cliente hostil intenta colar un registradoPor -- el endpoint no lo acepta
        // como campo del payload validado (bitacoraNom251EntradaSchema no lo declara).
        registradoPor: randomUUID(),
      }),
    });
    expect(res.status).toBe(201);

    const { rows } = await fixture.engine.admin.query<{ registrado_por: string }>(
      `select registrado_por from public.bitacora_nom251_entry where hotel_id = $1 and tipo = 'limpieza' order by seq desc limit 1;`,
      [hotelId],
    );
    const fnbStaffId = fixture.seed.hotels[0]!.staff.find((s) => s.role === "fnb")!.id;
    expect(rows[0]!.registrado_por).toBe(fnbStaffId);
  });

  it("GET lista las bitácoras capturadas, anotadas con quién las registró", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251?tipo=temperatura`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bitacoras: BitacoraListada[] };
    expect(body.bitacoras.length).toBeGreaterThanOrEqual(2);
    expect(body.bitacoras.every((b) => b.tipo === "temperatura")).toBe(true);
    expect(body.bitacoras.some((b) => b.anomalia === true)).toBe(true);
    expect(body.bitacoras.some((b) => b.registradoPor.length > 0)).toBe(true);
  });

  it("GET lista está restringida a owner/gm/fnb -- housekeeping no puede leerla", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251`, {
      headers: { authorization: `Bearer ${housekeepingToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("EXPORTAR (CSV) exige el parámetro tipo", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251/exportar`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);
  });

  it("EXPORTAR (CSV) de temperatura trae los campos exigidos por la norma, con los valores reales capturados", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251/exportar?tipo=temperatura`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="bitacora-nom251-temperatura-/);
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("fecha_hora,equipo,tipo_equipo,temperatura_c,rango_min_c,rango_max_c,dentro_de_rango,registrado_por");
    // Las dos capturas de temperatura de este hotel (3°C dentro de rango, 11°C fuera)
    // deben aparecer -- ninguna se descarta del export por estar fuera de rango.
    expect(lines.some((l) => l.includes(",3,0,4,si,"))).toBe(true);
    expect(lines.some((l) => l.includes(",11,0,4,no,"))).toBe(true);
  });

  it("EXPORTAR (CSV) está restringido a owner/gm -- fnb puede capturar pero no exportar el reporte de cumplimiento", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/bitacoras-nom251/exportar?tipo=limpieza`, {
      headers: { authorization: `Bearer ${fnbToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("INALTERABLE: UPDATE directo sobre bitacora_nom251_entry se rechaza incluso con el cliente admin", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `select id from public.bitacora_nom251_entry where hotel_id = $1 and tipo = 'limpieza' limit 1;`,
      [hotelId],
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      fixture.engine.admin.query(`update public.bitacora_nom251_entry set payload = '{}'::jsonb where id = $1;`, [rows[0]!.id]),
    ).rejects.toThrow(/bitacora_nom251_append_only/);
  });

  it("INALTERABLE: DELETE directo sobre bitacora_nom251_entry se rechaza incluso con el cliente admin", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `select id from public.bitacora_nom251_entry where hotel_id = $1 and tipo = 'limpieza' limit 1;`,
      [hotelId],
    );
    await expect(
      fixture.engine.admin.query(`delete from public.bitacora_nom251_entry where id = $1;`, [rows[0]!.id]),
    ).rejects.toThrow(/bitacora_nom251_append_only/);
  });

  it("la cadena de hash está encadenada por hotel: cada renglón referencia el hash del anterior del MISMO hotel", async () => {
    const { rows } = await fixture.engine.admin.query<{ prev_hash: string | null; hash: string }>(
      `select prev_hash, hash from public.bitacora_nom251_entry where hotel_id = $1 order by seq asc;`,
      [hotelId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0]!.prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }
  });
});
