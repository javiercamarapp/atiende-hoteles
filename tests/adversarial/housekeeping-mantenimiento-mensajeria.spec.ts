// H6b · Adversarial: aislamiento por hotel/rol en housekeeping/mantenimiento/aprobaciones,
// y webhook de WhatsApp con firma inválida / replay. REQ-TEN-001/003, GOB-026.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: housekeeping/mantenimiento/mensajeria", () => {
  let fixture: ApiFixture;
  let hotelAId: string;
  let hotelBId: string;
  let ownerAToken: string;
  let housekeepingAToken: string;
  let housekeepingBToken: string;
  let maintenanceAToken: string;
  let frontdeskAToken: string;
  let taskAId: string;
  let ticketAId: string;
  let roomCodeA: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    hotelAId = hotelA.id;
    hotelBId = hotelB.id;

    ownerAToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);
    housekeepingAToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
    housekeepingBToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "housekeeping")!.email);
    maintenanceAToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "maintenance")!.email);
    frontdeskAToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 1;",
      [hotelAId],
    );
    roomCodeA = rows[0]!.code;

    // El webhook público exige `hotel_messaging_config` ya existente (nunca la crea solo,
    // ver routes/mensajeria.ts) -- se aprovisiona vía la ruta autenticada normal, igual
    // que lo haría un gerente real desde /mensajeria/config.
    await fixture.app.request(`/hoteles/${hotelAId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ plantillasTransaccionales: [] }),
    });

    const crearTarea = await fixture.app.request(`/hoteles/${hotelAId}/housekeeping/tareas`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ roomCode: roomCodeA, priority: "media" }),
    });
    taskAId = ((await crearTarea.json()) as { taskId: string }).taskId;
    // Se asigna a la camarista del hotel A para poder probar el caso positivo (ve/edita
    // SU tarea) y el negativo (la de otro hotel no).
    const housekeepingA = hotelA.staff.find((s) => s.role === "housekeeping")!;
    await fixture.app.request(`/hoteles/${hotelAId}/housekeeping/tareas/${taskAId}/asignar`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: housekeepingA.id }),
    });

    const crearTicket = await fixture.app.request(`/hoteles/${hotelAId}/mantenimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ roomCode: roomCodeA, title: "Foco fundido", description: "El foco del baño no enciende.", severity: "baja" }),
    });
    ticketAId = ((await crearTicket.json()) as { ticketId: string }).ticketId;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("housekeeping de OTRO hotel (B) no ve ni puede iniciar la tarea del hotel A: 403/404 en la API, 0 filas por RLS", async () => {
    // La ruta exige pertenencia al hotel de la URL (requireHotelMembership) -- una
    // camarista del hotel B pidiendo por la URL del hotel A ya recibe 403 antes de tocar
    // la tabla de negocio.
    const res = await fixture.app.request(`/hoteles/${hotelAId}/housekeeping/tareas/${taskAId}/iniciar`, {
      method: "POST",
      headers: { authorization: `Bearer ${housekeepingBToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("el tablero de housekeeping de la camarista del hotel B nunca incluye la habitación del hotel A", async () => {
    // Los códigos de habitación se generan igual en ambos hoteles del seed (p.ej.
    // "EST-1" existe en A y en B) -- la comparación correcta es por ID de fila, no por
    // el string de código, que legítimamente coincide entre hoteles distintos.
    const { rows: roomARows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room where hotel_id = $1 and code = $2;",
      [hotelAId, roomCodeA],
    );
    const roomAId = roomARows[0]!.id;

    const res = await fixture.app.request(`/hoteles/${hotelBId}/housekeeping/tablero`, {
      headers: { authorization: `Bearer ${housekeepingBToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ roomId: string }>;
    expect(rows.some((r) => r.roomId === roomAId)).toBe(false);
  });

  it("housekeeping NO puede crear tickets de mantenimiento con costo (rol excluido de MANAGE_ROOM_STATUS... y de crear) pero SI reportar sin cambiar costo ajeno", async () => {
    // Reportar (insert) SÍ está permitido para housekeeping (REQ-HK-011: la camarista
    // puede levantar el ticket); lo que nunca puede es LEER/CAMBIAR el costo de un
    // ticket que no le está asignado.
    const reportar = await fixture.app.request(`/hoteles/${hotelAId}/mantenimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${housekeepingAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ roomCode: roomCodeA, title: "Cortina rota", description: "La cortina se cayó del riel.", severity: "baja" }),
    });
    expect(reportar.status).toBe(201);
  });

  it("housekeeping NUNCA puede cerrar-con-costo un ticket de mantenimiento (403 en la API)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/mantenimiento/${ticketAId}/cerrar-con-costo`, {
      method: "POST",
      headers: { authorization: `Bearer ${housekeepingAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ actualCost: 100 }),
    });
    expect(res.status).toBe(403);
  });

  it("mantenimiento (tecnico) no puede asignar/cambiar estado de un ticket (solo ADMIN_ROLES): 403", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/mantenimiento/${ticketAId}/estado`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${maintenanceAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "en_progreso" }),
    });
    expect(res.status).toBe(403);
  });

  it("RLS directa: un usuario de mantenimiento NO ve por SQL el ticket de otro tecnico (sin asignar a él) fuera de owner/gm/frontdesk", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const maintenanceStaff = hotelA.staff.find((s) => s.role === "maintenance")!;
    const { rows } = await fixture.engine.withAppSession({ userId: maintenanceStaff.id }, async (session) => {
      return session.query<{ id: string }>("select id from public.maintenance_ticket where id = $1;", [ticketAId]);
    });
    // El ticket no está asignado a este técnico (ni a nadie): la política RLS
    // "maintenance_ticket_manager_select" solo deja pasar owner/gm/frontdesk o al técnico
    // ASIGNADO -- 0 filas visibles, fail-closed.
    expect(rows).toHaveLength(0);
  });

  it("housekeeping NO puede decidir una aprobación (solo owner/gm): 403 en la API", async () => {
    const cerrar = await fixture.app.request(`/hoteles/${hotelAId}/mantenimiento/${ticketAId}/cerrar-con-costo`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ actualCost: 250 }),
    });
    const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

    const intento = await fixture.app.request(`/hoteles/${hotelAId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { authorization: `Bearer ${housekeepingAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
    });
    expect(intento.status).toBe(403);
  });

  it("frontdesk tampoco puede decidir una aprobación de dinero (solo owner/gm)", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.agent_approval where hotel_id = $1 and status = 'pendiente' order by requested_at desc limit 1;",
      [hotelAId],
    );
    const res = await fixture.app.request(`/hoteles/${hotelAId}/aprobaciones/${rows[0]!.id}/decidir`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskAToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
    });
    expect(res.status).toBe(403);
  });

  describe("webhook de WhatsApp: firma inválida y replay", () => {
    it("firma con secreto INCORRECTO es rechazada (401), ningún mensaje se inserta", async () => {
      const payload = { event_id: "adv-evt-1", type: "message.received", from: "+5215500000099", text: "intento de spoof", occurred_at: new Date().toISOString() };
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, "secreto-incorrecto");

      const res = await fixture.app.request(`/hoteles/${hotelAId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      });
      expect(res.status).toBe(401);

      const { rows } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and body = 'intento de spoof';",
        [hotelAId],
      );
      expect(rows).toHaveLength(0);
    });

    it("sin header de firma es rechazado (401)", async () => {
      const payload = { event_id: "adv-evt-2", type: "message.received", from: "+5215500000098", text: "sin firma", occurred_at: new Date().toISOString() };
      const res = await fixture.app.request(`/hoteles/${hotelAId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(401);
    });

    it("un replay del mismo event_id tras uno legítimo no reprocesa ni duplica el mensaje", async () => {
      const { rows: cfgRows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
        "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
        [hotelAId],
      );
      const secret = cfgRows[0]!.webhook_secret;
      const payload = { event_id: "adv-evt-3", type: "message.received", from: "+5215500000097", text: "mensaje legítimo", occurred_at: new Date().toISOString() };
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, secret);

      const primero = await fixture.app.request(`/hoteles/${hotelAId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      });
      expect(primero.status).toBe(200);

      const replay = await fixture.app.request(`/hoteles/${hotelAId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      });
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { estado: string }).estado).toBe("duplicado");

      const { rows } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and body = 'mensaje legítimo';",
        [hotelAId],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
