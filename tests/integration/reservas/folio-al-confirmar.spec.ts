// H4 · auditoría-1/backend [ALTO]: "No existe ningún camino en la API para crear un
// folio; los endpoints de cargos/pagos son inalcanzables en producción"
// (docs/auditoria-1/backend.md). Reproduce el hallazgo exacto: la única forma de llegar
// a un `folioId` documentada como evidencia previa (tests/integration/api/reservas-y-
// folios.spec.ts) usaba `fixture.engine.admin.query("insert into public.folio ...")` --
// un privilegio que ningún usuario real del producto tiene. Esta prueba NUNCA usa el
// cliente admin para crear el folio: confirma la reserva por la API real y espera poder
// llegar al folio (y cargarle algo) por la API real. Antes del arreglo, GET de la
// reserva no expone `folioId` y no existe ninguna fila en `folio` para verificar contra
// -- el flujo completo de cobro (REQ-REC-003/004) es inalcanzable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("el folio se crea al confirmar la reserva, alcanzable SIN el cliente admin (auditoría-1 ALTO)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let seededDates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    seededDates = rows.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}` };
  }

  it("confirmar una reserva crea su folio (sin insertarlo por el cliente admin) y GET de la reserva expone folioId", async () => {
    const checkIn = seededDates[0]!;
    const checkOut = seededDates[1]!;

    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(creada.status).toBe(201);
    const { id } = (await creada.json()) as { id: string };

    // Antes de confirmar: la reserva todavía no tiene folio.
    const antes = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}`, { headers: auth() });
    const antesBody = (await antes.json()) as { folioId?: string | null };
    expect(antesBody.folioId ?? null).toBeNull();

    const confirmada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(confirmada.status).toBe(200);

    const despues = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}`, { headers: auth() });
    expect(despues.status).toBe(200);
    const { folioId } = (await despues.json()) as { folioId: string | null };
    expect(folioId).not.toBeNull();

    // El folio existe de verdad en la tabla (una sola vez), no es un valor inventado por
    // la ruta de lectura.
    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string; reservation_id: string; status: string }>(
      "select id, reservation_id, status from public.folio where reservation_id = $1;",
      [id],
    );
    expect(folioRows).toHaveLength(1);
    expect(folioRows[0]!.id).toBe(folioId);
    expect(folioRows[0]!.status).toBe("abierto");

    // Cargo/pago alcanzables por la API real usando SOLO el folioId devuelto por la API
    // (nunca el cliente admin) -- cierra el hallazgo ALTO exacto de la auditoría.
    const cargo = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Primera noche", monto: 1000, impuesto: 160 }),
    });
    expect(cargo.status).toBe(201);
  });

  it("re-confirmar (transición no-op) o llegar a check_in no duplica el folio (única fila por reserva)", async () => {
    const checkIn = seededDates[5]!;
    const checkOut = seededDates[6]!;
    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    const { id } = (await creada.json()) as { id: string };

    await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    const checkInRes = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "check_in" }),
    });
    expect(checkInRes.status).toBe(200);

    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.folio where reservation_id = $1;",
      [id],
    );
    expect(folioRows).toHaveLength(1);
  });
});
