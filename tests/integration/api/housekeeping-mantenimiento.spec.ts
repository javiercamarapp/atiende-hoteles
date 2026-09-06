// H6b · /housekeeping y /mantenimiento vía la API real (REQ-HK-001/002/003/011/013/014):
// tablero, ciclo de vida de una tarea de housekeeping, y ciclo de vida de un ticket de
// mantenimiento incluida la autorización de gasto con doble confirmación de DOS actores
// reales (owner + gm) a través de /aprobaciones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: housekeeping + mantenimiento + aprobaciones (integración real)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomCode: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
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

  it("GET tablero lista habitaciones con housekeeping_status por defecto 'sucia'", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tablero`, { headers: authOf(gmToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ roomCode: string; housekeepingStatus: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r) => r.housekeepingStatus === "sucia")).toBe(true);
  });

  it("ciclo completo de una tarea de housekeeping: crear → asignar → iniciar → terminar", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const housekeepingStaff = hotel.staff.find((s) => s.role === "housekeeping")!;

    const crear = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, priority: "alta", checklist: ["tender cama", "revisar baño"] }),
    });
    expect(crear.status).toBe(201);
    const { taskId } = (await crear.json()) as { taskId: string };

    const asignar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/asignar`, {
      method: "PATCH",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: housekeepingStaff.id }),
    });
    expect(asignar.status).toBe(200);

    const iniciar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/iniciar`, {
      method: "POST",
      headers: authOf(housekeepingToken),
    });
    expect(iniciar.status).toBe(200);
    expect(((await iniciar.json()) as { estado: string }).estado).toBe("en_progreso");

    const terminar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/terminar`, {
      method: "POST",
      headers: authOf(housekeepingToken),
    });
    expect(terminar.status).toBe(200);

    const inspeccionar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/inspeccionar`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ resultado: "aprobada" }),
    });
    expect(inspeccionar.status).toBe(200);
    expect(((await inspeccionar.json()) as { housekeepingStatus: string }).housekeepingStatus).toBe("inspeccionada");
  });

  it("fuera de servicio: solo owner/gm, cambia housekeeping_status de la habitación", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room where hotel_id = $1 and code = $2;",
      [hotelId, roomCode],
    );
    const roomId = rows[0]!.id;

    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomId}/fuera-de-servicio`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ fueraDeServicio: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { housekeepingStatus: string }).housekeepingStatus).toBe("fuera_de_servicio");
  });

  it("mantenimiento: crear ticket detecta duplicado dentro de 24h", async () => {
    const body = { roomCode, title: "Fuga de agua", description: "Fuga bajo el lavabo del baño.", severity: "alta", estimatedCost: 1500 };

    const primero = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(primero.status).toBe(201);
    const { ticketId, marksOutOfService } = (await primero.json()) as { ticketId: string; marksOutOfService: boolean };
    expect(marksOutOfService).toBe(true);

    const segundo = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(segundo.status).toBe(201);
    const dup = (await segundo.json()) as { ticketId: string; duplicate?: boolean };
    expect(dup.ticketId).toBe(ticketId);
    expect(dup.duplicate).toBe(true);
  });

  // auditoria-2/frontend [ALTO]: un ticket reportado SIN costo estimado (el formulario
  // de "Reportar" no lo exige) debe quedar como `null` ("sin estimar") -- nunca como 0,
  // que Mantenimiento.tsx mostraría como "Estimado: $0.00 MXN" (una medición
  // fabricada). Migración 0080 volvió `estimated_cost` nullable para esto.
  it("mantenimiento: crear ticket sin costo estimado persiste null, no 0 (REQ-UX-002)", async () => {
    const crear = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, title: "Foco fundido (sin costo)", description: "Cambiar foco del pasillo." }),
    });
    expect(crear.status).toBe(201);
    const { ticketId } = (await crear.json()) as { ticketId: string };

    const lista = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, { headers: authOf(gmToken) });
    expect(lista.status).toBe(200);
    const tickets = (await lista.json()) as { id: string; costoEstimado: number | null }[];
    const ticket = tickets.find((t) => t.id === ticketId);
    expect(ticket).toBeDefined();
    expect(ticket!.costoEstimado).toBeNull();
  });

  it("cerrar-con-costo: requiere DOBLE confirmación de owner + gm, luego cierra el ticket y ejecuta la tool", async () => {
    const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, title: "AC no enfría", description: "El AC no enfría lo suficiente.", severity: "media", estimatedCost: 5000 }),
    });
    const { ticketId } = (await crearTicket.json()) as { ticketId: string };

    const cerrar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ actualCost: 4800, partUsed: "Capacitor de arranque" }),
    });
    expect(cerrar.status).toBe(202);
    const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

    // Primera confirmación (gm).
    const primeraDecision = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo $4,800 MXN por capacitor de arranque." }),
    });
    expect(primeraDecision.status).toBe(200);
    expect(((await primeraDecision.json()) as { estado: string }).estado).toBe("pendiente");

    // Segunda confirmación (owner) — DISTINTO actor y rol → completa y EJECUTA.
    const segundaDecision = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo $4,800 MXN por capacitor de arranque." }),
    });
    expect(segundaDecision.status).toBe(200);
    const segundaBody = (await segundaDecision.json()) as { estado: string; ejecutado: boolean };
    expect(segundaBody.estado).toBe("aprobada");
    expect(segundaBody.ejecutado).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ status: string; actual_cost: string }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(rows[0]!.status).toBe("cerrado");
    expect(Number(rows[0]!.actual_cost)).toBe(4800);
  });

  it("GET /aprobaciones lista y filtra por ?estado= (regresión: cast de enum agent_approval_status)", async () => {
    const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, title: "Ventana atascada", description: "La ventana no cierra bien.", severity: "baja" }),
    });
    const { ticketId } = (await crearTicket.json()) as { ticketId: string };
    await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ actualCost: 300 }),
    });

    const sinFiltro = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones`, { headers: authOf(gmToken) });
    expect(sinFiltro.status).toBe(200);
    const todas = (await sinFiltro.json()) as Array<{ estado: string }>;
    expect(todas.length).toBeGreaterThan(0);

    const conFiltro = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones?estado=pendiente`, { headers: authOf(gmToken) });
    expect(conFiltro.status).toBe(200);
    const pendientes = (await conFiltro.json()) as Array<{ estado: string }>;
    expect(pendientes.length).toBeGreaterThan(0);
    expect(pendientes.every((a) => a.estado === "pendiente")).toBe(true);
  });
});
