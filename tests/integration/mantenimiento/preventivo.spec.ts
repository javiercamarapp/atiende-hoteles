// REQ-HK-015 (docs/ACEPTACION.md): "Calendario de mantenimiento preventivo por activo
// crítico ajustado a ocupación y temporada; historial y costo por activo permite
// calcular recomendación reparar vs. reemplazar (verificado con 2 activos de costo
// distinto)." Integración real contra embedded-postgres (ADR-003): activos, ventanas de
// temporada, calendario y recomendación, todo a través de la API real (nunca insertando
// directo salvo para PREPARAR un escenario que la API todavía no expone, ej. anclar la
// fecha exacta de la última MP registrada -- documentado en cada caso). El unit puro de
// `packages/domain-hotel/src/mantenimiento/preventivo.ts` vive en
// `tests/unit/domain-hotel/mantenimiento-preventivo.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: mantenimiento preventivo (REQ-HK-015, integración real)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomCode: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 1;",
      [hotelId],
    );
    roomCode = rows[0]!.code;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}` });
  const jsonHeaders = (token: string) => ({ ...authOf(token), "content-type": "application/json" });

  it("caso negativo: housekeeping no puede dar de alta un activo crítico (403)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
      method: "POST",
      headers: jsonHeaders(housekeepingToken),
      body: JSON.stringify({
        name: "Intento no autorizado",
        category: "otro",
        installDate: "2024-01-01",
        replacementCost: 1000,
        baseFrequencyDays: 30,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("caso negativo: crear un activo con una habitación que no existe en el hotel falla con 400", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({
        name: "Minisplit fantasma",
        category: "minisplit",
        roomCode: "NO-EXISTE-999",
        installDate: "2024-01-01",
        replacementCost: 8000,
        baseFrequencyDays: 90,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("calendario ajustado a temporada: una ventana que cubre todo el año aprieta la frecuencia base", async () => {
    const crearActivo = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({
        name: "Minisplit habitación de prueba",
        category: "minisplit",
        roomCode,
        installDate: "2024-01-01",
        replacementCost: 8000,
        baseFrequencyDays: 90,
      }),
    });
    expect(crearActivo.status).toBe(201);
    const { id: assetId } = (await crearActivo.json()) as { id: string };

    // Ancla la última MP registrada exactamente `baseFrequencyDays` días antes de
    // "ahora" -- así el vencimiento calculado por el dominio cae en el día de hoy,
    // sin depender de en qué fecha del año corra la prueba (evita date-rot: no se
    // asume ningún mes/día concreto). Se inserta directo porque la API de
    // "registrar-preventivo" siempre usa el reloj real del servidor (`now()`), y este
    // caso necesita controlar la fecha exacta para el escenario de ocupación de abajo.
    const anchor = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await fixture.engine.admin.query(
      `insert into public.critical_asset_maintenance_event (tenant_id, hotel_id, asset_id, completed_at, cost)
       values ($1, $2, $3, $4, 0);`,
      [fixture.seed.orgId, hotelId, assetId, anchor.toISOString()],
    );

    const sinTemporada = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/calendario-preventivo`, { headers: authOf(ownerToken) });
    expect(sinTemporada.status).toBe(200);
    const calendarioSinTemporada = (await sinTemporada.json()) as Array<{ activoId: string; frecuenciaEfectivaDias: number; ventanaTemporadaAplicada: string | null }>;
    const entradaSinTemporada = calendarioSinTemporada.find((e) => e.activoId === assetId)!;
    expect(entradaSinTemporada.frecuenciaEfectivaDias).toBe(90);
    expect(entradaSinTemporada.ventanaTemporadaAplicada).toBeNull();

    // Ventana "pre-huracanes" cubriendo el año completo (01-01..12-31): SIEMPRE aplica,
    // sin importar la fecha real de ejecución de la prueba. Apretada a 20 días (< 90).
    const crearTemporada = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/temporadas`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ label: "pre-huracanes", startMonthDay: "01-01", endMonthDay: "12-31", frequencyDays: 20 }),
    });
    expect(crearTemporada.status).toBe(201);

    const conTemporada = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/calendario-preventivo`, { headers: authOf(ownerToken) });
    const calendarioConTemporada = (await conTemporada.json()) as Array<{ activoId: string; frecuenciaEfectivaDias: number; ventanaTemporadaAplicada: string | null; vencimiento: string; pospuestoPorOcupacionDias: number }>;
    const entradaConTemporada = calendarioConTemporada.find((e) => e.activoId === assetId)!;
    expect(entradaConTemporada.frecuenciaEfectivaDias).toBe(20);
    expect(entradaConTemporada.ventanaTemporadaAplicada).toBe("pre-huracanes");
    // Con la ventana apretada (20 días desde el ancla), el vencimiento ajustado cae
    // ANTES que el vencimiento sin temporada (90 días desde el mismo ancla) -- el
    // calendario de temporada SIEMPRE aprieta, nunca afloja.
    const vencimientoSinTemporada = anchor.getTime() + 90 * 24 * 60 * 60 * 1000;
    expect(new Date(entradaConTemporada.vencimiento).getTime()).toBeLessThan(vencimientoSinTemporada);

    // --- ajustado a ocupación: "MP en habitaciones vacías" ---
    // El vencimiento SIN temporada (90 días desde el ancla) cae exactamente HOY. Se
    // marca la habitación como ocupada y se verifica que el calendario pospone la MP
    // al día siguiente en vez de agendarla en una habitación ocupada.
    await fixture.engine.admin.query("update public.room set status = 'ocupada' where hotel_id = $1 and code = $2;", [hotelId, roomCode]);

    // Se borra la ventana de temporada para volver a observar el vencimiento base
    // (90 días = hoy) y aislar el efecto de ocupación del de temporada.
    const listaTemporadas = (await (await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/temporadas`, { headers: authOf(ownerToken) })).json()) as Array<{ id: string }>;
    for (const ventana of listaTemporadas) {
      await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/temporadas/${ventana.id}`, { method: "DELETE", headers: authOf(ownerToken) });
    }

    const conOcupacion = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/calendario-preventivo`, { headers: authOf(ownerToken) });
    const calendarioConOcupacion = (await conOcupacion.json()) as Array<{
      activoId: string;
      vencimiento: string;
      pospuestoPorOcupacionDias: number;
      forzadoPorOcupacion: boolean;
    }>;
    const entradaConOcupacion = calendarioConOcupacion.find((e) => e.activoId === assetId)!;
    expect(entradaConOcupacion.pospuestoPorOcupacionDias).toBe(1);
    expect(entradaConOcupacion.forzadoPorOcupacion).toBe(false);
    // El vencimiento ajustado por ocupación queda un día después del vencimiento base
    // (que caía hoy, con la habitación ocupada).
    const vencimientoBase = new Date(anchor.getTime() + 90 * 24 * 60 * 60 * 1000);
    const vencimientoAjustado = new Date(entradaConOcupacion.vencimiento);
    expect(Math.round((vencimientoAjustado.getTime() - vencimientoBase.getTime()) / (24 * 60 * 60 * 1000))).toBe(1);

    // Libera la habitación de nuevo para no contaminar otros tests de este archivo.
    await fixture.engine.admin.query("update public.room set status = 'disponible' where hotel_id = $1 and code = $2;", [hotelId, roomCode]);
  });

  it("un activo sin habitación (no room_id) nunca se pospone por ocupación", async () => {
    const crearActivo = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ name: "Generador de emergencia", category: "generador", installDate: "2024-01-01", replacementCost: 150_000, baseFrequencyDays: 180 }),
    });
    expect(crearActivo.status).toBe(201);
    const { id: assetId } = (await crearActivo.json()) as { id: string };

    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/calendario-preventivo`, { headers: authOf(ownerToken) });
    const calendario = (await res.json()) as Array<{ activoId: string; habitacionCodigo: string | null; pospuestoPorOcupacionDias: number }>;
    const entrada = calendario.find((e) => e.activoId === assetId)!;
    expect(entrada.habitacionCodigo).toBeNull();
    expect(entrada.pospuestoPorOcupacionDias).toBe(0);
  });

  // El caso central del criterio de aceptación: "verificado con 2 activos de costo
  // distinto" -- mismo historial de reparación acumulado ($6,000), costo de reemplazo
  // distinto, recomendación distinta.
  it("recomendación reparar vs. reemplazar difiere entre 2 activos de costo de reemplazo distinto con el mismo historial", async () => {
    const crear = async (name: string, replacementCost: number) => {
      const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ name, category: "bomba", installDate: "2020-01-01", replacementCost, baseFrequencyDays: 365 }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };

    const activoBaratoId = await crear("Bomba de alberca secundaria (barata)", 8_000);
    const activoCaroId = await crear("Bomba de alberca principal (cara)", 60_000);

    for (const assetId of [activoBaratoId, activoCaroId]) {
      for (const cost of [2000, 2500, 1500]) {
        const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos/${assetId}/registrar-preventivo`, {
          method: "POST",
          headers: jsonHeaders(ownerToken),
          body: JSON.stringify({ cost, note: "Reparación registrada en la prueba" }),
        });
        expect(res.status).toBe(201);
      }
    }

    const recBarato = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos/${activoBaratoId}/recomendacion`, { headers: authOf(ownerToken) });
    expect(recBarato.status).toBe(200);
    const bodyBarato = (await recBarato.json()) as { recomendacion: string; ratioCosto: number; costoAcumulado12Meses: number };
    expect(bodyBarato.costoAcumulado12Meses).toBe(6000);
    expect(bodyBarato.ratioCosto).toBeCloseTo(0.75, 5);
    expect(bodyBarato.recomendacion).toBe("reemplazar");

    const recCaro = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos/${activoCaroId}/recomendacion`, { headers: authOf(ownerToken) });
    expect(recCaro.status).toBe(200);
    const bodyCaro = (await recCaro.json()) as { recomendacion: string; ratioCosto: number; costoAcumulado12Meses: number };
    expect(bodyCaro.costoAcumulado12Meses).toBe(6000);
    expect(bodyCaro.ratioCosto).toBeCloseTo(0.1, 5);
    expect(bodyCaro.recomendacion).toBe("reparar");
  });

  it("un activo sin ningún historial de costo recomienda reparar (no hay evidencia de que reemplazar convenga)", async () => {
    const crear = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ name: "Cerradura electrónica nueva", category: "cerradura", installDate: "2026-01-01", replacementCost: 3000, baseFrequencyDays: 365 }),
    });
    const { id: assetId } = (await crear.json()) as { id: string };

    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos/${assetId}/recomendacion`, { headers: authOf(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recomendacion: string; numeroEventosDeCosto: number };
    expect(body.recomendacion).toBe("reparar");
    expect(body.numeroEventosDeCosto).toBe(0);
  });

  it("caso negativo: recomendación de un activo inexistente devuelve 404", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos/00000000-0000-0000-0000-000000000000/recomendacion`, {
      headers: authOf(ownerToken),
    });
    expect(res.status).toBe(404);
  });

  it("GET /activos lista los activos críticos del hotel con su habitación (cuando aplica)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos-criticos`, { headers: authOf(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ nombre: string; habitacionCodigo: string | null }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((a) => a.habitacionCodigo === roomCode)).toBe(true);
  });
});
