// REQ-AB-010 (docs/ACEPTACION.md): "Merma de inventario F&B registrada por causa
// (clima/robo/caducidad/etc.) en todos los centros de consumo (verificado con un
// registro por causa)." Contra embedded-postgres real (ADR-003), sin doble de prueba:
// el criterio de aceptación declara "Depende de credenciales: No" -- esta prueba
// ejercita `POST/GET /hoteles/:hotelId/fnb-merma` (rutas reales de
// apps/api/src/routes/fnbMerma.ts) de punta a punta, incluyendo RLS real y el CHECK
// estructural de la migración 0130_fnb_merma.sql.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";
import { FNB_CENTROS_CONSUMO, FNB_MERMA_CAUSAS } from "@atiende-hoteles/domain-hotel";

interface MermaBody {
  id: string;
  centroConsumo: string;
  item: string;
  cantidad: number;
  unidad: string;
  causa: string;
  nota: string | null;
  creadoEn: string;
}

describe("REQ-AB-010: merma de inventario F&B registrada por causa en todos los centros de consumo", () => {
  let fixture: ApiFixture;
  let fnbToken: string;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    fnbToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "fnb")!.email);
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  beforeEach(async () => {
    // Cada `it` corre su propio escenario independiente sobre la MISMA base (mismo
    // criterio que tests/integration/tickets/sla-escalado.spec.ts).
    await fixture.engine.admin.exec("truncate table public.fnb_merma restart identity cascade;");
  });

  async function registrarMerma(
    token: string,
    body: { centroConsumo?: string; item?: string; cantidad?: number; unidad?: string; causa?: string; nota?: string },
  ) {
    return fixture.app.request(`/hoteles/${hotelId}/fnb-merma`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function listarMerma(token: string, query = ""): Promise<MermaBody[]> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb-merma${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as MermaBody[];
  }

  it("registra un ajuste de merma válido en un centro de consumo con causa clasificada", async () => {
    const res = await registrarMerma(fnbToken, {
      centroConsumo: "restaurante",
      item: "camarones",
      cantidad: 2.5,
      unidad: "kg",
      causa: "caducidad",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as MermaBody;
    expect(body.centroConsumo).toBe("restaurante");
    expect(body.causa).toBe("caducidad");
    expect(body.cantidad).toBe(2.5);
    expect(body.nota).toBeNull();

    const listado = await listarMerma(gmToken);
    expect(listado).toHaveLength(1);
    expect(listado[0]!.id).toBe(body.id);
  });

  it("REQ-AB-010 literal: el 100% de los ajustes queda clasificado -- un registro por cada causa del catálogo, en centros de consumo distintos", async () => {
    // Un registro por cada causa canónica (H10-015: "clima, huracán, robo,
    // caducidad" + "otro" del "etc." de REQ-AB-010), repartidos entre varios de los
    // centros de consumo de H10-011 -- verifica "todos los centros de consumo" y "un
    // registro por causa" al mismo tiempo, tal como exige el criterio de aceptación.
    const centros = FNB_CENTROS_CONSUMO;
    for (const [i, causa] of FNB_MERMA_CAUSAS.entries()) {
      const centroConsumo = centros[i % centros.length]!;
      const res = await registrarMerma(fnbToken, {
        centroConsumo,
        item: `insumo-${causa}`,
        cantidad: 1,
        causa,
        nota: causa === "otro" ? "vidrio roto durante inventario" : undefined,
      });
      expect(res.status).toBe(201);
    }

    const listado = await listarMerma(gmToken);
    expect(listado).toHaveLength(FNB_MERMA_CAUSAS.length);
    // El 100% de los registros tiene una causa del catálogo cerrado -- ninguno queda
    // "sin clasificar" (H10-015).
    const causasRegistradas = new Set(listado.map((m) => m.causa));
    for (const causa of FNB_MERMA_CAUSAS) expect(causasRegistradas.has(causa)).toBe(true);
    expect(causasRegistradas.size).toBe(FNB_MERMA_CAUSAS.length);

    const reporteRes = await fixture.app.request(`/hoteles/${hotelId}/fnb-merma/reporte-por-causa`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(reporteRes.status).toBe(200);
    const reporte = (await reporteRes.json()) as { causa: string; registros: number; cantidadTotal: number }[];
    expect(reporte).toHaveLength(FNB_MERMA_CAUSAS.length);
    for (const fila of reporte) {
      expect(fila.registros).toBe(1); // "un registro por causa" -- literal del criterio de aceptación
    }
  });

  it('CASO NEGATIVO: la causa "otro" sin nota se rechaza -- nunca persiste un ajuste sin clasificación útil', async () => {
    const res = await registrarMerma(fnbToken, {
      centroConsumo: "minibar",
      item: "chocolates",
      cantidad: 3,
      causa: "otro",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");

    // Nada quedó persistido -- el registro rechazado nunca llegó a la base.
    expect(await listarMerma(gmToken)).toHaveLength(0);
  });

  it("CASO NEGATIVO: una causa fuera del enum cerrado se rechaza (nunca texto libre sin clasificar)", async () => {
    const res = await registrarMerma(fnbToken, {
      centroConsumo: "restaurante",
      item: "aceite",
      cantidad: 1,
      causa: "se_evaporo",
    });
    expect(res.status).toBe(400);
    expect(await listarMerma(gmToken)).toHaveLength(0);
  });

  it("CASO NEGATIVO: un centro de consumo fuera del enum cerrado se rechaza", async () => {
    const res = await registrarMerma(fnbToken, {
      centroConsumo: "cocina_secreta",
      item: "vino",
      cantidad: 1,
      causa: "robo",
    });
    expect(res.status).toBe(400);
    expect(await listarMerma(gmToken)).toHaveLength(0);
  });

  it("CASO NEGATIVO: cantidad cero o negativa se rechaza", async () => {
    const cero = await registrarMerma(fnbToken, { centroConsumo: "pool_bar", item: "hielo", cantidad: 0, causa: "clima" });
    expect(cero.status).toBe(400);
    const negativa = await registrarMerma(fnbToken, { centroConsumo: "pool_bar", item: "hielo", cantidad: -1, causa: "clima" });
    expect(negativa.status).toBe(400);
    expect(await listarMerma(gmToken)).toHaveLength(0);
  });

  it("el CHECK estructural de BD también rechaza causa 'otro' sin nota, incluso saltándose la ruta HTTP (defensa en dos capas, ver migración 0130)", async () => {
    await expect(
      fixture.engine.admin.query(
        `insert into public.fnb_merma (tenant_id, hotel_id, centro_consumo, item, cantidad, causa, registered_by)
         values ($1, $2, 'restaurante', 'vino', 1, 'otro', null);`,
        [fixture.seed.orgId, hotelId],
      ),
    ).rejects.toThrow();
  });

  it("el CHECK estructural de BD rechaza una causa fuera del enum incluso saltándose la aplicación", async () => {
    await expect(
      fixture.engine.admin.query(
        `insert into public.fnb_merma (tenant_id, hotel_id, centro_consumo, item, cantidad, causa, registered_by)
         values ($1, $2, 'restaurante', 'vino', 1, 'causa_inventada', null);`,
        [fixture.seed.orgId, hotelId],
      ),
    ).rejects.toThrow();
  });

  it("frontdesk NO puede capturar merma de F&B (fuera de su rol operativo)", async () => {
    const res = await registrarMerma(frontdeskToken, {
      centroConsumo: "restaurante",
      item: "pan",
      cantidad: 1,
      causa: "caducidad",
    });
    expect(res.status).toBe(403);
  });

  it("owner/gm puede borrar un registro de merma para corregir una captura equivocada; fnb NO puede borrar", async () => {
    const creado = await registrarMerma(fnbToken, {
      centroConsumo: "desayuno",
      item: "huevos",
      cantidad: 12,
      unidad: "pza",
      causa: "caducidad",
    });
    const { id } = (await creado.json()) as MermaBody;

    const intentoFnb = await fixture.app.request(`/hoteles/${hotelId}/fnb-merma/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${fnbToken}` },
    });
    expect(intentoFnb.status).toBe(403);
    expect(await listarMerma(gmToken)).toHaveLength(1);

    const borrado = await fixture.app.request(`/hoteles/${hotelId}/fnb-merma/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(borrado.status).toBe(204);
    expect(await listarMerma(gmToken)).toHaveLength(0);
  });

  it("filtra por causa y por centro de consumo vía query string", async () => {
    await registrarMerma(fnbToken, { centroConsumo: "restaurante", item: "a", cantidad: 1, causa: "robo" });
    await registrarMerma(fnbToken, { centroConsumo: "pool_bar", item: "b", cantidad: 1, causa: "clima" });
    await registrarMerma(fnbToken, { centroConsumo: "restaurante", item: "c", cantidad: 1, causa: "clima" });

    const porCausa = await listarMerma(gmToken, "?causa=clima");
    expect(porCausa).toHaveLength(2);
    expect(porCausa.every((m) => m.causa === "clima")).toBe(true);

    const porCentro = await listarMerma(gmToken, "?centroConsumo=restaurante");
    expect(porCentro).toHaveLength(2);
    expect(porCentro.every((m) => m.centroConsumo === "restaurante")).toBe(true);
  });
});
