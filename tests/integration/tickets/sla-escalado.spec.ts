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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";
import {
  escalateOverdueGuestTickets,
  notifyApproachingSlaGuestTickets,
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
  avisoSla75En: string | null;
}

describe("REQ-HUE-014: mensaje del huésped → ticket con departamento/habitación/prioridad/SLA + escalación automática", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let tenantId: string;
  let roomCode: string;
  let roomCode2: string;
  // Staff real sembrado por seedDev (un `staff_user` por rol por hotel, ver
  // packages/db/src/seed.ts) -- usado por las pruebas de notificación activa de más
  // abajo para verificar QUIÉN recibe cada alerta (asignado/supervisor/roles de
  // escalación), no solo que "se envió algo".
  let maintenanceStaff: { id: string; email: string; role: string };
  let gmStaff: { id: string; email: string; role: string };
  let ownerStaff: { id: string; email: string; role: string };

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    tenantId = fixture.seed.orgId;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    maintenanceStaff = hotelA.staff.find((s) => s.role === "maintenance")!;
    gmStaff = hotelA.staff.find((s) => s.role === "gm")!;
    ownerStaff = hotelA.staff.find((s) => s.role === "owner")!;

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

  // ---------------------------------------------------------------------------------
  // REQ-HUE-014 (ampliación "notificación activa", patrón Duve/Optii verificado hoy):
  // al 75% del SLA se alerta al asignado+supervisor, al 100% se escala -- ambos SIEMPRE
  // por notificación activa (no solo un cambio de `status` en la base). Las pruebas de
  // arriba ya cubren el cambio de estado/auditoría del 100%; las de abajo cubren el
  // aviso al 75% y que AMBOS umbrales disparan una notificación activa real (verificada
  // con un `dispatch` inyectado -- nunca contacta la API real de Meta/WhatsApp ni
  // ningún endpoint real, mismo criterio de "reloj/red inyectados, nunca reales" que el
  // resto de este archivo).
  // ---------------------------------------------------------------------------------
  describe("aviso temprano al 75% del SLA (antes de la escalación al 100%)", () => {
    it("marca el aviso exactamente al alcanzar el 75% del SLA, no antes, y es idempotente", async () => {
      const res = await crearTicket(frontdeskToken, {
        guestMessage: "El aire acondicionado hace un ruido raro.",
        department: "maintenance",
        priority: "alta", // SLA 30 min -> umbral de aviso a los 22.5 min (75%)
        roomCode,
      });
      const { ticketId } = (await res.json()) as { ticketId: string };
      const ticket = await leerTicket(ticketId);
      const slaDueAt = new Date(ticket.slaVenceEn);
      // `slaDueAt` viene de `sla_due_at::text` -> `new Date(...)`, que trunca la
      // precisión de microsegundos que sí tiene el `timestamptz` real de Postgres
      // (`created_at`/`sla_due_at` comparten el mismo `now()` de la transacción, ver
      // ticketTools.ts). El umbral EXACTO al microsegundo ya está probado sin ese
      // margen de error en `tests/unit/domain-hotel/ticket-sla-policy.spec.ts`
      // (`computeSlaWarningAt`/`isSlaWarningDue`, Dates puros de JS, sin ida y vuelta
      // por Postgres) -- aquí, contra la BD real, se usa un margen de +1ms sobre el
      // umbral aproximado para no depender de esa fracción de microsegundo perdida.
      const umbralAproximado = new Date(slaDueAt.getTime() - 30 * 0.25 * 60_000); // 75% de 30 min
      const yaEnElUmbral = new Date(umbralAproximado.getTime() + 1);

      // Un minuto ANTES del umbral: todavía no se avisa.
      const antes = await notifyApproachingSlaGuestTickets(
        fixture.engine.admin,
        { hotelId, tenantId },
        { now: () => new Date(umbralAproximado.getTime() - 60_000) },
      );
      expect(antes.warned.map((t) => t.id)).not.toContain(ticketId);
      expect((await leerTicket(ticketId)).avisoSla75En).toBeNull();

      // Al llegar al umbral del 75%: sí se avisa (a diferencia de `isSlaOverdue`, que
      // usa `>` estricto en el 100%, el aviso preventivo del 75% dispara con `>=`, ver
      // `isSlaWarningDue`).
      const primera = await notifyApproachingSlaGuestTickets(
        fixture.engine.admin,
        { hotelId, tenantId },
        { now: () => yaEnElUmbral },
      );
      expect(primera.warned.map((t) => t.id)).toContain(ticketId);
      expect(primera.supervisorRoles).toEqual(["gm"]);
      const avisado = primera.warned.find((t) => t.id === ticketId)!;
      expect(avisado.department).toBe("maintenance");
      expect(avisado.assignedTo).toBeNull(); // nadie asignado todavía

      const despues = await leerTicket(ticketId);
      expect(despues.avisoSla75En).not.toBeNull();
      expect(despues.estado).toBe("abierto"); // el aviso NO cambia el estado del ticket

      // Segunda corrida sobre el mismo instante: no reenvía (idempotente, mismo
      // criterio que la escalación al 100%).
      const segunda = await notifyApproachingSlaGuestTickets(
        fixture.engine.admin,
        { hotelId, tenantId },
        { now: () => yaEnElUmbral },
      );
      expect(segunda.warned.map((t) => t.id)).not.toContain(ticketId);

      const { rows: auditRows } = await fixture.engine.admin.query<{ id: string }>(
        "select id from public.audit_log where hotel_id = $1 and action = 'guest_ticket.alerta_sla_75';",
        [hotelId],
      );
      expect(auditRows).toHaveLength(1);
    });

    it("un ticket cerrado antes de llegar al 75% de su SLA nunca recibe el aviso", async () => {
      const res = await crearTicket(frontdeskToken, {
        guestMessage: "Falta shampoo.",
        department: "housekeeping",
        priority: "alta", // SLA 30 min
        roomCode,
      });
      const { ticketId } = (await res.json()) as { ticketId: string };

      const cierre = await fixture.app.request(`/hoteles/${hotelId}/tickets/${ticketId}/cerrar`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
        body: JSON.stringify({ resolutionNote: "Entregado por camarista." }),
      });
      expect(cierre.status).toBe(200);

      const resultado = await notifyApproachingSlaGuestTickets(
        fixture.engine.admin,
        { hotelId, tenantId },
        { now: () => new Date(Date.now() + 24 * 60 * 60_000) }, // muy por delante, si siguiera abierto ya habría avisado
      );
      expect(resultado.warned.map((t) => t.id)).not.toContain(ticketId);
    });
  });

  describe("notificación ACTIVA (webhook genérico inyectado -- nunca la API real de Meta/WhatsApp)", () => {
    it("al 75% del SLA despacha una alerta activa al asignado directo + supervisor(gm) + el departamento del ticket", async () => {
      const res = await crearTicket(frontdeskToken, {
        guestMessage: "El aire acondicionado no enfría bien.",
        department: "maintenance",
        priority: "alta", // SLA 30 min
        roomCode,
      });
      const { ticketId } = (await res.json()) as { ticketId: string };

      // Asigna el ticket a un miembro real del staff de mantenimiento -- sin ruta HTTP
      // para esto todavía (solo `reasignar` de departamento), se fija directo en BD
      // igual que el resto de este archivo fija `ticket_sla_policy`.
      await fixture.engine.admin.query("update public.guest_ticket set assigned_to = $1 where id = $2;", [
        maintenanceStaff.id,
        ticketId,
      ]);

      const ticket = await leerTicket(ticketId);
      const slaDueAt = new Date(ticket.slaVenceEn);
      // +1ms de margen sobre el umbral aproximado -- ver comentario extenso en la
      // prueba anterior (precisión de microsegundos de Postgres perdida al pasar por
      // `::text` -> `new Date(...)`).
      const yaEnElUmbral = new Date(slaDueAt.getTime() - 30 * 0.25 * 60_000 + 1);

      const dispatch = vi.fn().mockResolvedValue(undefined);
      const scheduler = new TicketEscalationScheduler(fixture.engine.admin, {
        now: () => yaEnElUmbral,
        dispatch,
        alertDestination: { webhookUrl: "https://hooks.example.test/tickets" },
      });
      const results = await scheduler.tick([{ id: hotelId, tenantId }]);
      expect(results.find((r) => r.hotelId === hotelId)?.warningResult?.warned.map((t) => t.id)).toContain(ticketId);

      const llamadasDeEsteTicket = dispatch.mock.calls.filter(([alerta]) => (alerta as { ticket_id: string }).ticket_id === ticketId);
      expect(llamadasDeEsteTicket).toHaveLength(1);
      const [alerta, destino] = llamadasDeEsteTicket[0]!;
      expect((alerta as { tipo: string }).tipo).toBe("ticket_sla_alerta_75");
      expect(destino).toEqual({ webhookUrl: "https://hooks.example.test/tickets" });
      const destinatarios = (alerta as { destinatarios: string[] }).destinatarios;
      expect(destinatarios).toContain(maintenanceStaff.email); // asignado directo
      expect(destinatarios).toContain(gmStaff.email); // supervisor (default ["gm"])

      // Todavía NO venció del todo -- ninguna llamada de escalación para este ticket.
      expect(dispatch.mock.calls.some(([a]) => (a as { tipo: string }).tipo === "ticket_sla_escalado")).toBe(false);
    });

    it("al 100% del SLA (escalación) despacha una alerta activa a los roles reales gm+owner del hotel", async () => {
      const res = await crearTicket(frontdeskToken, {
        guestMessage: "No hay agua caliente.",
        department: "maintenance",
        priority: "alta",
        roomCode,
      });
      const { ticketId } = (await res.json()) as { ticketId: string };
      const ticket = await leerTicket(ticketId);
      const slaDueAt = new Date(ticket.slaVenceEn);

      const dispatch = vi.fn().mockResolvedValue(undefined);
      const scheduler = new TicketEscalationScheduler(fixture.engine.admin, {
        now: () => new Date(slaDueAt.getTime() + 60_000),
        dispatch,
        alertDestination: { webhookUrl: "https://hooks.example.test/tickets" },
      });
      await scheduler.tick([{ id: hotelId, tenantId }]);

      const llamadaEscalacion = dispatch.mock.calls.find(
        ([alerta]) => (alerta as { tipo: string; ticket_id: string }).tipo === "ticket_sla_escalado" && (alerta as { ticket_id: string }).ticket_id === ticketId,
      );
      expect(llamadaEscalacion).toBeDefined();
      const [alerta] = llamadaEscalacion!;
      const destinatarios = (alerta as { destinatarios: string[]; roles_destinatario: string[] }).destinatarios;
      expect((alerta as { roles_destinatario: string[] }).roles_destinatario).toEqual(["gm", "owner"]);
      expect(destinatarios).toContain(gmStaff.email);
      expect(destinatarios).toContain(ownerStaff.email);
    });

    it("sin ningún ticket por avisar ni por escalar, el planificador no despacha ninguna notificación activa", async () => {
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const scheduler = new TicketEscalationScheduler(fixture.engine.admin, {
        now: () => new Date(),
        dispatch,
        alertDestination: { webhookUrl: "https://hooks.example.test/tickets" },
      });
      await scheduler.tick([{ id: hotelId, tenantId }]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
