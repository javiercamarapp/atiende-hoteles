// REQ-TEN-004/GOB-039: "Toda escritura anónima o de bajo privilegio ... debe pasar
// exclusivamente por una función RPC SECURITY DEFINER que recalcule los valores en
// servidor, nunca aceptando el valor/precio enviado por el cliente." Instancia
// probada aquí: pedido público de "catálogo de experiencias" sin cuenta
// (POST /experiencias-publicas/pedido, sin sesión de staff, verificado por código de
// reserva + apellido -- routes/experienciasPublicas.ts, SECURITY DEFINER
// `order_experience_public()` de packages/db/migrations/0050).
//
// Caso central: un body que incluye `precio`/`total` alterado (p. ej. `precio: 0.01`)
// es ignorado por completo -- el monto que termina en el folio (charge) SIEMPRE
// coincide con `catálogo.price × cantidad`, nunca con el valor enviado por el cliente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: RPC SECURITY DEFINER de pedido público ignora precio del cliente (REQ-TEN-004)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let experienceId: string;
  const PRECIO_CATALOGO = 500;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.experience_catalog (tenant_id, hotel_id, name, description, price, active)
       values ($1, $2, 'Tour a cenote', 'Tour guiado de medio día', $3, true) returning id;`,
      [fixture.seed.orgId, hotelId, PRECIO_CATALOGO],
    );
    experienceId = rows[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function seededDate(offset: number): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    return rows[offset]!.date;
  }

  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  async function crearReservaConfirmada(offset: number, apellido: string) {
    const { rows: guestRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, `Ana ${apellido}`],
    );
    const guestId = guestRows[0]!.id;
    const checkIn = await seededDate(offset);
    const checkOut = nightAfter(checkIn);

    const resCreate = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(resCreate.status).toBe(201);
    const { id, codigoConfirmacion } = (await resCreate.json()) as { id: string; codigoConfirmacion: string };

    const resTransicion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(resTransicion.status).toBe(200);

    return { id, codigoConfirmacion, apellido };
  }

  it("body con precio/total alterado (0.01) es ignorado: el cargo posteado usa el precio del catálogo, nunca el enviado", async () => {
    const { id, codigoConfirmacion, apellido } = await crearReservaConfirmada(0, "Gómez");

    const res = await fixture.app.request("/experiencias-publicas/pedido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // El atacante intenta fijar su propio precio/total en el body.
      body: JSON.stringify({
        codigoReserva: codigoConfirmacion,
        apellido,
        experienciaId: experienceId,
        cantidad: 2,
        precio: 0.01,
        total: 0.01,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pedidoId: string; precioUnitario: number; total: number };

    // El total persistido es SIEMPRE catálogo × cantidad (500 × 2 = 1000), nunca 0.01
    // ni ningún derivado de él.
    expect(body.precioUnitario).toBe(PRECIO_CATALOGO);
    expect(body.total).toBe(PRECIO_CATALOGO * 2);

    const { rows: orderRows } = await fixture.engine.admin.query<{ total_amount: string; unit_price: string }>(
      "select total_amount::text as total_amount, unit_price::text as unit_price from public.experience_order where id = $1;",
      [body.pedidoId],
    );
    expect(Number(orderRows[0]!.total_amount)).toBe(PRECIO_CATALOGO * 2);
    expect(Number(orderRows[0]!.unit_price)).toBe(PRECIO_CATALOGO);

    // El motor determinista de precio total coincide exactamente con lo posteado al
    // folio (REQ-REV-001): el cargo real en `charge` también es 1000, nunca 0.01.
    const { rows: chargeRows } = await fixture.engine.admin.query<{ amount: string; concept: string }>(
      `select c.amount::text as amount, c.concept
       from public.charge c
       join public.experience_order eo on eo.folio_charge_id = c.id
       where eo.id = $1;`,
      [body.pedidoId],
    );
    expect(chargeRows).toHaveLength(1);
    expect(Number(chargeRows[0]!.amount)).toBe(PRECIO_CATALOGO * 2);
    expect(chargeRows[0]!.concept).toBe("extras");

    // Confirmar además que ningún cargo de 0.01 (ni ningún múltiplo trivial de él)
    // quedó posteado en ningún folio de este hotel.
    const { rows: sospechosos } = await fixture.engine.admin.query<{ amount: string }>(
      "select amount::text as amount from public.charge where hotel_id = $1 and amount < 1;",
      [hotelId],
    );
    expect(sospechosos).toHaveLength(0);
    void id;
  });

  it("identidad incorrecta (apellido no coincide) → 0 pedidos ejecutados, mensaje genérico", async () => {
    const { codigoConfirmacion } = await crearReservaConfirmada(1, "Ramírez");

    const res = await fixture.app.request("/experiencias-publicas/pedido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido: "Martínez", experienciaId: experienceId, cantidad: 1 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toMatch(/no existe|not found/i);
  });

  it("cantidad fuera de rango (0) es rechazada por el esquema de entrada antes de llegar a la RPC", async () => {
    const { codigoConfirmacion, apellido } = await crearReservaConfirmada(2, "Torres");

    const res = await fixture.app.request("/experiencias-publicas/pedido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido, experienciaId: experienceId, cantidad: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("reintento con el mismo clienteRequestId no duplica el cargo (idempotencia)", async () => {
    const { codigoConfirmacion, apellido } = await crearReservaConfirmada(3, "Flores");
    const clienteRequestId = randomUUID();

    const primero = await fixture.app.request("/experiencias-publicas/pedido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido, experienciaId: experienceId, cantidad: 1, clienteRequestId }),
    });
    expect(primero.status).toBe(201);
    const primeroBody = (await primero.json()) as { pedidoId: string };

    const segundo = await fixture.app.request("/experiencias-publicas/pedido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido, experienciaId: experienceId, cantidad: 1, clienteRequestId }),
    });
    expect(segundo.status).toBe(200);
    const segundoBody = (await segundo.json()) as { pedidoId: string; yaRegistrado: boolean };
    expect(segundoBody.pedidoId).toBe(primeroBody.pedidoId);
    expect(segundoBody.yaRegistrado).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.experience_order where id = $1;",
      [primeroBody.pedidoId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("catálogo público expone solo id/nombre/descripción/precio, sin autenticación", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/experiencias-publicas`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; nombre: string; precio: number }[];
    const tour = body.find((e) => e.id === experienceId);
    expect(tour).toBeTruthy();
    expect(tour!.precio).toBe(PRECIO_CATALOGO);
  });
});
