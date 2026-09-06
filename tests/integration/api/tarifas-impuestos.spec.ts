// auditoria-2/arquitectura [MEDIO] · `hotel_tax_config` se leía por dos caminos
// distintos con dos semánticas de error DISTINTAS para el mismo hecho de negocio ("este
// hotel no tiene impuestos configurados"): `pms/taxConfig.ts::loadTaxConfig` (usado por
// quotes.ts/reservas.ts) respondía 400, y `routes/tarifas.ts` reimplementaba la MISMA
// consulta a mano y respondía 404. Corregido: tarifas.ts reutiliza `loadTaxConfig` en
// vez de reimplementar la consulta -- esta prueba fija que ambos caminos ahora
// coinciden.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("GET /hoteles/:hotelId/impuestos vs. loadTaxConfig (auditoria-2/arquitectura MEDIO)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  afterEach(async () => {
    // Restaura la fila real que seedDev sembró, para no afectar otras pruebas de este
    // mismo fixture si algún día se agregan más a este describe.
    await fixture.engine.admin.query(
      `insert into public.hotel_tax_config (hotel_id, tenant_id, iva_rate, ish_rate)
       select id, org_id, 0.16, 0.03 from public.hotel where id = $1
       on conflict (hotel_id) do nothing;`,
      [hotelId],
    );
  });

  it("sin fila en hotel_tax_config: GET /impuestos responde 400 (misma semántica que quotes.ts/reservas.ts vía loadTaxConfig), NUNCA 404", async () => {
    await fixture.engine.admin.query("delete from public.hotel_tax_config where hotel_id = $1;", [hotelId]);

    const res = await fixture.app.request(`/hoteles/${hotelId}/impuestos`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/no tiene impuestos/i);
  });

  it("con fila real: GET /impuestos responde 200 con los valores reales (sin reimplementar la consulta)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/impuestos`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ivaRate: number; ishRate: number };
    expect(body.ivaRate).toBeGreaterThan(0);
  });
});
