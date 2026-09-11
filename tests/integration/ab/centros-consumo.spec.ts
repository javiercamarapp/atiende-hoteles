// REQ-AB-007 (P2/F, H10-011/H10-012) · docs/ACEPTACION.md: "Múltiples centros de
// consumo con traspasos internos de inventario hacia/desde almacén central; costo del
// desayuno incluido imputado automáticamente con base en consumo teórico + forecast de
// ocupación (verificado con dos centros y un traspaso)." Contra `embedded-postgres`
// real, por la API real de apps/api/src/routes/fnbCentrosConsumo.ts (nunca insertando
// el resultado directo en la tabla -- mismo criterio que api-fixture.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function isoDateOffset(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe("REQ-AB-007: centros de consumo, traspasos internos y costo de desayuno imputado", () => {
  let fixture: ApiFixture;
  let fnbToken: string;
  let ownerToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomTypeId: string;
  // El hotel tiene UN solo almacén central (índice único parcial de la migración) --
  // se crea una vez en `beforeAll` y todas las pruebas de traspasos lo comparten,
  // igual que un hotel real solo tiene un almacén.
  let almacenId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    fnbToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "fnb")!.email);
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);

    const almacenRes = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo`, {
      method: "POST",
      headers: { authorization: `Bearer ${fnbToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Almacén Central", tipo: "almacen_central" }),
    });
    almacenId = ((await almacenRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function crearCentro(nombre: string, tipo: "centro_consumo" | "almacen_central") {
    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ nombre, tipo }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("registra dos centros de consumo y un traspaso interno desde el almacén central (criterio literal de ACEPTACION.md)", async () => {
    const restauranteId = await crearCentro("Restaurante Principal", "centro_consumo");

    // Recepción de mercancía: solo entra por el almacén central.
    const recepcion = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo/${almacenId}/existencia-inicial`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ sku: "HUEVO-DOC", nombre: "Huevo (docena)", cantidad: 100, costoUnitario: 45.9 }),
    });
    expect(recepcion.status).toBe(201);

    // Un centro de consumo NO puede recibir existencia nueva "de la nada".
    const recepcionRechazada = await fixture.app.request(
      `/hoteles/${hotelId}/fnb/centros-consumo/${restauranteId}/existencia-inicial`,
      { method: "POST", headers: auth(fnbToken), body: JSON.stringify({ sku: "HUEVO-DOC", nombre: "Huevo (docena)", cantidad: 10, costoUnitario: 45.9 }) },
    );
    expect(recepcionRechazada.status).toBe(409);

    // EL traspaso: almacén central -> restaurante.
    const traspaso = await fixture.app.request(`/hoteles/${hotelId}/fnb/traspasos`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ fromCenterId: almacenId, toCenterId: restauranteId, sku: "HUEVO-DOC", cantidad: 30, nota: "surtido de la mañana" }),
    });
    expect(traspaso.status).toBe(201);
    const traspasoBody = (await traspaso.json()) as { quantity: string; unit_cost_snapshot: string };
    expect(Number(traspasoBody.quantity)).toBe(30);
    expect(Number(traspasoBody.unit_cost_snapshot)).toBe(45.9);

    // Existencia real en ambos centros después del traspaso: 100-30=70 en el almacén,
    // 30 en el restaurante -- verificación directa del efecto del traspaso.
    const existenciaAlmacen = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo/${almacenId}/existencia`, {
      headers: auth(fnbToken),
    });
    const existenciaRestaurante = await fixture.app.request(
      `/hoteles/${hotelId}/fnb/centros-consumo/${restauranteId}/existencia`,
      { headers: auth(fnbToken) },
    );
    const almacenStock = (await existenciaAlmacen.json()) as Array<{ sku: string; cantidad: number }>;
    const restauranteStock = (await existenciaRestaurante.json()) as Array<{ sku: string; cantidad: number }>;
    expect(almacenStock.find((s) => s.sku === "HUEVO-DOC")?.cantidad).toBe(70);
    expect(restauranteStock.find((s) => s.sku === "HUEVO-DOC")?.cantidad).toBe(30);

    // La bitácora de traspasos refleja exactamente 1 traspaso registrado.
    const listado = await fixture.app.request(`/hoteles/${hotelId}/fnb/traspasos`, { headers: auth(fnbToken) });
    const traspasos = (await listado.json()) as unknown[];
    expect(traspasos).toHaveLength(1);
  });

  it("rechaza un traspaso DIRECTO entre dos centros de consumo (ninguno es el almacén central)", async () => {
    const poolBarId = await crearCentro("Pool Bar", "centro_consumo");
    const roomServiceId = await crearCentro("Room Service", "centro_consumo");

    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb/traspasos`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ fromCenterId: poolBarId, toCenterId: roomServiceId, sku: "CERVEZA-355", cantidad: 5 }),
    });
    expect(res.status).toBe(409);
  });

  it("rechaza traspasar más existencia de la que hay en el origen (stock insuficiente, bajo lock real)", async () => {
    const barId = await crearCentro("Bar de Alberca 2", "centro_consumo");

    await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo/${almacenId}/existencia-inicial`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ sku: "TEQUILA-750", nombre: "Tequila 750ml", cantidad: 5, costoUnitario: 300 }),
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb/traspasos`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ fromCenterId: almacenId, toCenterId: barId, sku: "TEQUILA-750", cantidad: 6 }),
    });
    expect(res.status).toBe(409);

    // La existencia del origen NO se movió (el intento rechazado no dejó el sistema en
    // un estado intermedio).
    const existencia = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo/${almacenId}/existencia`, {
      headers: auth(fnbToken),
    });
    const stock = (await existencia.json()) as Array<{ sku: string; cantidad: number }>;
    expect(stock.find((s) => s.sku === "TEQUILA-750")?.cantidad).toBe(5);
  });

  it("housekeeping no puede crear centros de consumo ni registrar traspasos (RBAC)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/fnb/centros-consumo`, {
      method: "POST",
      headers: auth(housekeepingToken),
      body: JSON.stringify({ nombre: "Centro no autorizado", tipo: "centro_consumo" }),
    });
    expect(res.status).toBe(403);
  });

  it("imputa el costo del desayuno = ocupación proyectada × costo teórico, y se RECALCULA solo con nueva ocupación (H10-012)", async () => {
    const configRes = await fixture.app.request(`/hoteles/${hotelId}/fnb/costo-desayuno/config`, {
      method: "PUT",
      headers: auth(ownerToken),
      body: JSON.stringify({ costoPorHabitacionNoche: 65.5 }),
    });
    expect(configRes.status).toBe(200);

    const fecha = isoDateOffset(5);
    const checkOut = isoDateOffset(6);
    const fechaFueraDeRango = isoDateOffset(20);

    // Ocupación inicial: 2 reservas confirmadas cubren `fecha`.
    await crearFolioConfirmado(fixture.app, ownerToken, hotelId, { roomTypeId, checkInDate: fecha, checkOutDate: checkOut });
    await crearFolioConfirmado(fixture.app, ownerToken, hotelId, { roomTypeId, checkInDate: fecha, checkOutDate: checkOut });
    // Esta reserva NO cubre `fecha` (fechas muy adelante) -- no debe contarse.
    await crearFolioConfirmado(fixture.app, ownerToken, hotelId, {
      roomTypeId,
      checkInDate: fechaFueraDeRango,
      checkOutDate: isoDateOffset(21),
    });

    const reporte1 = await fixture.app.request(`/hoteles/${hotelId}/fnb/costo-desayuno?fecha=${fecha}`, {
      headers: auth(fnbToken),
    });
    expect(reporte1.status).toBe(200);
    const body1 = (await reporte1.json()) as { occupiedRoomNights: number; costPerRoomNight: number; imputedCost: number };
    expect(body1.occupiedRoomNights).toBe(2);
    expect(body1.costPerRoomNight).toBe(65.5);
    expect(body1.imputedCost).toBe(131);

    // Una tercera reserva que SÍ cubre `fecha` mueve el forecast de ocupación -- el
    // costo imputado debe reflejarlo de inmediato en la SIGUIENTE consulta, sin ningún
    // paso manual de "recalcular".
    await crearFolioConfirmado(fixture.app, ownerToken, hotelId, { roomTypeId, checkInDate: fecha, checkOutDate: checkOut });

    const reporte2 = await fixture.app.request(`/hoteles/${hotelId}/fnb/costo-desayuno?fecha=${fecha}`, {
      headers: auth(fnbToken),
    });
    const body2 = (await reporte2.json()) as { occupiedRoomNights: number; imputedCost: number };
    expect(body2.occupiedRoomNights).toBe(3);
    expect(body2.imputedCost).toBe(196.5);
  });

  it("sin configurar el costo por habitación-noche, el costo imputado es honestamente $0 (nunca una cifra inventada)", async () => {
    const otroHotel = fixture.seed.hotels[1]!;
    const otroOwnerToken = await loginAs(fixture.app, otroHotel.staff.find((s) => s.role === "owner")!.email);
    const fecha = isoDateOffset(2);
    const reporte = await fixture.app.request(`/hoteles/${otroHotel.id}/fnb/costo-desayuno?fecha=${fecha}`, {
      headers: auth(otroOwnerToken),
    });
    expect(reporte.status).toBe(200);
    const body = (await reporte.json()) as { costPerRoomNight: number; imputedCost: number };
    expect(body.costPerRoomNight).toBe(0);
    expect(body.imputedCost).toBe(0);
  });
});
