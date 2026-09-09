// REQ-HUE-014 (docs/ACEPTACION.md): "Cada mensaje/petición se convierte en ticket con
// departamento/habitación/prioridad/SLA; ticket sin cierre dentro del SLA configurado
// escala automáticamente (verificado con reloj simulado superando el SLA)." Contra
// embedded-postgres real (ADR-003), sin ningún doble de prueba de canal (WhatsApp/voz):
// el criterio de aceptación de este REQ específico declara "Depende de credenciales: No"
// -- el canal de INGRESO del mensaje es un REQ aparte (REQ-HUE-001/002/004,
// "pendiente-credenciales"); esta prueba ejercita la conversión mensaje→ticket
// (`POST /hoteles/:hotelId/tickets`, misma tool de dominio
// `crear_ticket_huesped` que usaría el agente conversacional) y la escalación
// automática (`escalateOverdueGuestTickets`/`TicketEscalationScheduler`, RLS real
// incluida) de punta a punta.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";
import {
  escalateOverdueGuestTickets,
} from "../../../apps/api/src/jobs/ticketEscalation.ts";
import {
  loadHotelsForTicketEscalation,
  TicketEscalationScheduler,
} from "../../../apps/api/src/jobs/ticketEscalationScheduler.ts";

// Espejo EXACTO de `serializeTicket()` en apps/api/src/routes/tickets.ts (claves en
// español, mismo criterio que el resto de rutas de este repo, p.ej.
// routes/mantenimiento.ts).
interface TicketRow {
  id: string;
  departamento: string;
  prioridad: string;
  estado: string;
  canal: string;
  roomCode: string | null;
  slaMinutos: number;
  slaVenceEn: string;
  escaladoEn: string | null;
  escaladoARoles: string[];
}

describe("REQ-HUE-014: mensaje del huésped → ticket con departamento/habitación/prioridad/SLA + escalación automática", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let tenantId: string;
  let roomCode: string;
  let roomCode2: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    tenantId = fixture.seed.orgId;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 2;",
      [hotelId],
    );
    roomCode = rows[0]!.code;
    roomCode2 = rows[1]!.code;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  beforeEach(async () => {
    // Cada `it` corre su propio escenario independiente sobre la MISMA base (mismo
    // criterio que tests/integration/agent-core/journey-checkin-incidencia.spec.ts).
    await fixture.engine.admin.exec(
      "truncate table public.guest_ticket, public.ticket_sla_policy, public.audit_log restart identity cascade;",
    );
  });

  async function crearTicket(
    token: string,
    body: { guestMessage: string; roomCode?: string; department?: string; priority?: string; channel?: string },
  ) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  async function leerTicket(ticketId: string): Promise<TicketRow> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/tickets`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const tickets = (await res.json()) as (TicketRow & { id: string })[];
    const found = tickets.find((t) => t.id === ticketId);
    if (!found) throw new Error(`ticket ${ticketId} no encontrado en el listado`);
    return found;
  }

  it("convierte un mensaje del huésped en un ticket con departamento/habitación/prioridad/SLA (clasificación automática por defecto)", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "El aire acondicionado de mi habitación no funciona, es urgente.",
      roomCode,
      channel: "qr",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ticketId: string;
      department: string;
      priority: string;
      slaMinutes: number;
      slaDueAt: string;
    };
    expect(body.department).toBe("maintenance"); // clasificado por classifyGuestMessage
    expect(body.priority).toBe("alta");
    expect(body.slaMinutes).toBe(30); // default por prioridad alta (sin política propia configurada)

    const ticket = await leerTicket(body.ticketId);
    expect(ticket.departamento).toBe("maintenance");
    expect(ticket.prioridad).toBe("alta");
    expect(ticket.roomCode).toBe(roomCode);
    expect(ticket.canal).toBe("qr");
    expect(ticket.estado).toBe("abierto");
    expect(new Date(ticket.slaVenceEn).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("respeta el departamento/prioridad explícitos cuando el llamador ya los conoce (no reclasifica)", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "Petición transcrita por recepción.",
      department: "fnb",
      priority: "baja",
      roomCode,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; department: string; priority: string };
    expect(body.department).toBe("fnb");
    expect(body.priority).toBe("baja");
  });

  it("usa el SLA CONFIGURADO por el hotel (ticket_sla_policy) en vez del default, cuando existe", async () => {
    // REQ-HUE-014: "SLA configurado" -- el hotel fija 5 minutos para mantenimiento/alta
    // (mucho más agresivo que el default de 30), y el ticket recién creado debe
    // congelar ESE valor.
    await fixture.engine.admin.query(
      `insert into public.ticket_sla_policy (tenant_id, hotel_id, department, priority, sla_minutes)
       values ($1, $2, 'maintenance', 'alta', 5);`,
      [tenantId, hotelId],
    );

    const res = await crearTicket(frontdeskToken, {
      guestMessage: "Fuga de agua en el baño, urgente.",
      department: "maintenance",
      priority: "alta",
      roomCode,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; slaMinutes: number };
    expect(body.slaMinutes).toBe(5);
  });

  it("un ticket SIN cierre dentro del SLA escala automáticamente (reloj simulado superando el SLA)", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "El aire acondicionado no funciona.",
      department: "maintenance",
      priority: "alta", // default SLA 30 min
      roomCode,
    });
    expect(res.status).toBe(201);
    const { ticketId, slaMinutes } = (await res.json()) as { ticketId: string; slaMinutes: number };
    expect(slaMinutes).toBe(30);

    const antes = await leerTicket(ticketId);
    expect(antes.estado).toBe("abierto");
    expect(antes.escaladoEn).toBeNull();

    // Reloj simulado: exactamente EN el vencimiento (inclusive) todavía NO escala --
    // "sin cierre DENTRO del SLA" significa que el SLA completo cuenta como cumplido.
    const slaDueAt = new Date(antes.slaVenceEn);
    const resultadoEnElLimite = await escalateOverdueGuestTickets(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => slaDueAt },
    );
    expect(resultadoEnElLimite.escalated.map((t) => t.id)).not.toContain(ticketId);

    // Reloj simulado 1 minuto DESPUÉS del vencimiento del SLA de 30 min -> escala.
    const relojSimuladoSuperandoElSla = () => new Date(slaDueAt.getTime() + 60_000);
    const resultado = await escalateOverdueGuestTickets(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: relojSimuladoSuperandoElSla },
    );
    expect(resultado.escalated.map((t) => t.id)).toContain(ticketId);
    const escalado = resultado.escalated.find((t) => t.id === ticketId)!;
    expect(escalado.department).toBe("maintenance");
    expect(escalado.priority).toBe("alta");

    const despues = await leerTicket(ticketId);
    expect(despues.estado).toBe("escalado");
    expect(despues.escaladoEn).not.toBeNull();
    expect(despues.escaladoARoles).toEqual(["gm", "owner"]);

    // Bitácora de auditoría real de la escalación (REQ-HUE-014 "notificando al staff
    // correspondiente" -- este es el rastro auditable de esa notificación).
    const { rows: auditRows } = await fixture.engine.admin.query<{ action: string; payload: { ticketIds: string[] } }>(
      "select action, payload from public.audit_log where hotel_id = $1 and action = 'guest_ticket.escalado' order by created_at desc limit 1;",
      [hotelId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.payload.ticketIds).toContain(ticketId);
  });

  it("un ticket cuyo SLA todavía no vence NO escala (caso negativo: no escala todo indiscriminadamente)", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "¿Podrían traer más toallas cuando puedan?",
      department: "housekeeping",
      priority: "baja", // default SLA 480 min (8h)
      roomCode: roomCode2,
    });
    expect(res.status).toBe(201);
    const { ticketId } = (await res.json()) as { ticketId: string };

    // Reloj simulado solo 10 min después de creado -- muy por debajo del SLA de 8h.
    const resultado = await escalateOverdueGuestTickets(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => new Date(Date.now() + 10 * 60_000) },
    );
    expect(resultado.escalated.map((t) => t.id)).not.toContain(ticketId);

    const ticket = await leerTicket(ticketId);
    expect(ticket.estado).toBe("abierto");
  });

  it("un ticket CERRADO antes del SLA nunca escala, aunque el reloj simulado supere por mucho su SLA original", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "Falta papel higiénico.",
      department: "housekeeping",
      priority: "alta", // SLA 30 min
      roomCode,
    });
    expect(res.status).toBe(201);
    const { ticketId } = (await res.json()) as { ticketId: string };

    const cierre = await fixture.app.request(`/hoteles/${hotelId}/tickets/${ticketId}/cerrar`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ resolutionNote: "Papel entregado por camarista." }),
    });
    expect(cierre.status).toBe(200);

    const resultado = await escalateOverdueGuestTickets(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => new Date(Date.now() + 24 * 60 * 60_000) }, // 24h después, muy vencido si siguiera abierto
    );
    expect(resultado.escalated.map((t) => t.id)).not.toContain(ticketId);

    const ticket = await leerTicket(ticketId);
    expect(ticket.estado).toBe("cerrado");
    expect(ticket.escaladoEn).toBeNull();
  });

  it("reasignar el departamento de un ticket NO reinicia su SLA (el reloj del huésped no depende de a quién se lo enrutan internamente)", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "Necesito una copia de mi factura.",
      department: "frontdesk", // clasificado como "otro"/default por error del staff
      priority: "alta",
      roomCode,
    });
    const { ticketId } = (await res.json()) as { ticketId: string };
    const antes = await leerTicket(ticketId);

    const reasignado = await fixture.app.request(`/hoteles/${hotelId}/tickets/${ticketId}/reasignar`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ department: "reservations" }),
    });
    expect(reasignado.status).toBe(200);
    expect(((await reasignado.json()) as { departamento: string }).departamento).toBe("reservations");

    const despues = await leerTicket(ticketId);
    expect(despues.departamento).toBe("reservations");
    expect(despues.slaVenceEn).toBe(antes.slaVenceEn);
  });

  it("la escalación es idempotente: correr el planificador dos veces no reescala ni duplica auditoría", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "No hay agua caliente en la regadera.",
      department: "maintenance",
      priority: "alta",
      roomCode,
    });
    const { ticketId } = (await res.json()) as { ticketId: string };
    const ticketAntes = await leerTicket(ticketId);
    const slaDueAt = new Date(ticketAntes.slaVenceEn);
    const now = () => new Date(slaDueAt.getTime() + 5 * 60_000);

    const primera = await escalateOverdueGuestTickets(fixture.engine.admin, { hotelId, tenantId }, { now });
    expect(primera.escalated.map((t) => t.id)).toContain(ticketId);

    const segunda = await escalateOverdueGuestTickets(fixture.engine.admin, { hotelId, tenantId }, { now });
    expect(segunda.escalated.map((t) => t.id)).not.toContain(ticketId);

    const { rows: auditRows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.audit_log where hotel_id = $1 and action = 'guest_ticket.escalado';",
      [hotelId],
    );
    expect(auditRows).toHaveLength(1);
  });

  it("el planificador (TicketEscalationScheduler) escala de punta a punta contra TODOS los hoteles reales, con reloj inyectado", async () => {
    const res = await crearTicket(frontdeskToken, {
      guestMessage: "El elevador no funciona.",
      department: "maintenance",
      priority: "alta",
      roomCode,
    });
    const { ticketId } = (await res.json()) as { ticketId: string };
    const ticketAntes = await leerTicket(ticketId);
    const slaDueAt = new Date(ticketAntes.slaVenceEn);

    const hotels = await loadHotelsForTicketEscalation(fixture.engine.admin);
    expect(hotels.some((h) => h.id === hotelId)).toBe(true);

    const scheduler = new TicketEscalationScheduler(fixture.engine.admin, {
      now: () => new Date(slaDueAt.getTime() + 60_000),
    });
    const tickResults = await scheduler.tick(hotels);
    const hotelResult = tickResults.find((r) => r.hotelId === hotelId)!;
    expect(hotelResult.ran).toBe(true);
    expect(hotelResult.result?.escalated.map((t) => t.id)).toContain(ticketId);

    const ticket = await leerTicket(ticketId);
    expect(ticket.estado).toBe("escalado");
  });
});
