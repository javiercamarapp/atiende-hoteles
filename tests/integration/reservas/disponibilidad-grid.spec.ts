// H4 · GET /hoteles/:hotelId/disponibilidad/grid — desglose por día para la grilla
// tipo-de-habitación × día del frontend.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("GET /hoteles/:hotelId/disponibilidad/grid", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("devuelve un objeto por tipo de habitación con un arreglo de días en el rango, con inventario y tarifa reales", async () => {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 3;",
      [hotelId, roomTypeId],
    );
    const desde = rows[0]!.date;
    const hasta = rows[2]!.date;

    const res = await fixture.app.request(`/hoteles/${hotelId}/disponibilidad/grid?desde=${desde}&hasta=${hasta}`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tipoHabitacionId: string;
      tipoHabitacion: string;
      dias: { fecha: string; disponibles: number; total: number; tarifa: number }[];
    }[];

    const fila = body.find((f) => f.tipoHabitacionId === roomTypeId);
    expect(fila).toBeDefined();
    expect(fila!.dias).toHaveLength(3);
    expect(fila!.dias.map((d) => d.fecha)).toEqual([desde, rows[1]!.date, hasta]);
    expect(fila!.dias[0]!.total).toBe(5);
    expect(fila!.dias[0]!.tarifa).toBeGreaterThan(0);
  });

  it("hasta anterior a desde es rechazado (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/disponibilidad/grid?desde=2026-05-10&hasta=2026-05-01`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);
  });
});
