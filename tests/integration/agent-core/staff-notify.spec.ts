// H6b-notif · Notificación ACTIVA por WhatsApp al crear un `housekeeping_task`/
// `maintenance_ticket`/`guest_ticket` (staffNotify.ts). Antes de este cambio, la ÚNICA
// forma de enterarse de una tarea/ticket nueva era el tablero de staff
// (apps/api/src/routes/housekeeping.ts) -- ningún envío real ocurría. Verifica, contra
// un `embedded-postgres` REAL (staff_user.whatsapp_phone/hotel_staff, migraciones
// 0003/0053) y el `FakeWhatsappAdapter` real (nunca la red de Meta), que:
//   1) las 3 tools de creación notifican al rol/departamento responsable con el
//      teléfono de WhatsApp real de ese hotel;
//   2) sin adaptador configurado, o sin ningún destinatario con teléfono registrado,
//      la tarea/ticket se crea de todos modos (nunca se bloquea por la notificación);
//   3) un adaptador que falla ("best effort") tampoco bloquea la creación;
//   4) un ticket de mantenimiento duplicado (ventana de 24h) NO dispara una segunda
//      notificación (no se creó una segunda fila).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildToolContext,
  createGuestTicketTool,
  createHousekeepingTaskTool,
  createMaintenanceTicketTool,
  createRunBudget,
  type WhatsappSenderLike,
} from "@atiende-hoteles/agent-core";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";

let engine: EmbeddedPostgresEngine;
let seed: SeedResult;
let hotelId: string;
let roomCode: string;

beforeAll(async () => {
  engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  seed = await seedDev(engine.admin);
  hotelId = seed.hotels[0]!.id;

  const { rows } = await engine.admin.query<{ code: string }>(
    "select code from public.room where hotel_id = $1 order by code limit 1;",
    [hotelId],
  );
  roomCode = rows[0]!.code;
});

afterAll(async () => {
  await engine.stop();
});

afterEach(async () => {
  await engine.admin.exec(
    "truncate table public.maintenance_ticket, public.housekeeping_task, public.guest_ticket restart identity cascade;",
  );
  await engine.admin.query("update public.staff_user set whatsapp_phone = null where 1=1;");
});

function ctxFor(hotel: string, actorId: string) {
  return buildToolContext(
    { orgId: seed.orgId, hotelId: hotel, actor: { type: "staff" as const, id: actorId }, requestId: `req-${Math.random()}` },
    createRunBudget({}),
  );
}

function staffId(role: string): string {
  return seed.hotels[0]!.staff.find((s) => s.role === role)!.id;
}

async function setWhatsappPhone(staffUserId: string, phone: string): Promise<void> {
  await engine.admin.query("update public.staff_user set whatsapp_phone = $1 where id = $2;", [phone, staffUserId]);
}

describe("staffNotify: notificación activa de WhatsApp al crear housekeeping_task/maintenance_ticket/guest_ticket", () => {
  it("crear_tarea_housekeeping notifica por WhatsApp al staff con rol housekeeping que tiene teléfono registrado", async () => {
    await setWhatsappPhone(staffId("housekeeping"), "+5215511110001");
    const messaging = new FakeWhatsappAdapter();
    const spy = vi.spyOn(messaging, "sendTemplateMessage");

    const tool = createHousekeepingTaskTool({ db: engine.admin, messaging, simulated: true });
    const result = await tool.run(ctxFor(hotelId, staffId("gm")), {
      roomCode,
      priority: "alta",
      checklist: [],
    });

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ to: "+5215511110001", templateName: "tarea_housekeeping_nueva" });

    const data = result.data as { notificacion: { attempted: boolean; recipients: unknown[] } };
    expect(data.notificacion.attempted).toBe(true);
    expect(data.notificacion.recipients).toHaveLength(1);
  });

  it("crear_ticket_mantenimiento notifica al staff con rol maintenance, y NO reenvía en un duplicado dentro de 24h", async () => {
    await setWhatsappPhone(staffId("maintenance"), "+5215511110002");
    const messaging = new FakeWhatsappAdapter();
    const spy = vi.spyOn(messaging, "sendTemplateMessage");

    const tool = createMaintenanceTicketTool({ db: engine.admin, messaging, simulated: true });
    const input = {
      roomCode,
      title: "Fuga de agua",
      description: "Fuga bajo el lavabo del baño.",
      origin: "staff" as const,
      severity: "alta" as const,
      estimatedCost: 0,
    };

    const primero = await tool.run(ctxFor(hotelId, staffId("gm")), input);
    expect(primero.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ to: "+5215511110002", templateName: "ticket_mantenimiento_nuevo" });

    // Mismo título + habitación dentro de 24h -> la tool detecta el duplicado y NO
    // inserta una fila nueva (ver createMaintenanceTicketTool) -- por lo tanto tampoco
    // debe notificar una segunda vez.
    const segundo = await tool.run(ctxFor(hotelId, staffId("gm")), input);
    expect(segundo.ok).toBe(true);
    expect((segundo.data as { duplicate?: boolean }).duplicate).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("crear_ticket_huesped notifica al departamento (rol) indicado en el input", async () => {
    await setWhatsappPhone(staffId("frontdesk"), "+5215511110003");
    const messaging = new FakeWhatsappAdapter();
    const spy = vi.spyOn(messaging, "sendTemplateMessage");

    const tool = createGuestTicketTool({ db: engine.admin, messaging, simulated: true });
    const result = await tool.run(ctxFor(hotelId, staffId("gm")), {
      guestMessage: "Necesito una almohada extra",
      department: "frontdesk",
      priority: "media",
      channel: "staff",
    });

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ to: "+5215511110003", templateName: "ticket_huesped_nuevo" });
  });

  it("sin adaptador de mensajería configurado, la tarea se crea igual y la notificación se reporta 'sin_adaptador_configurado'", async () => {
    const tool = createHousekeepingTaskTool({ db: engine.admin });
    const result = await tool.run(ctxFor(hotelId, staffId("gm")), { roomCode, priority: "media", checklist: [] });

    expect(result.ok).toBe(true);
    const data = result.data as { notificacion: { attempted: boolean; reason?: string } };
    expect(data.notificacion.attempted).toBe(false);
    expect(data.notificacion.reason).toBe("sin_adaptador_configurado");
  });

  it("sin ningún staff del rol responsable con whatsapp_phone registrado, la tarea se crea igual", async () => {
    // Ningún staff tiene whatsapp_phone en este punto (afterEach lo limpia).
    const messaging = new FakeWhatsappAdapter();
    const spy = vi.spyOn(messaging, "sendTemplateMessage");
    const tool = createMaintenanceTicketTool({ db: engine.admin, messaging, simulated: true });

    const result = await tool.run(ctxFor(hotelId, staffId("gm")), {
      roomCode,
      title: "Foco fundido",
      description: "El foco del buró no enciende.",
      origin: "staff" as const,
      severity: "baja" as const,
      estimatedCost: 0,
    });

    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    const data = result.data as { notificacion: { attempted: boolean; reason?: string } };
    expect(data.notificacion.attempted).toBe(true);
    expect(data.notificacion.reason).toBe("sin_destinatarios_con_whatsapp");
  });

  it("best effort: un adaptador que falla no bloquea la creación del ticket", async () => {
    await setWhatsappPhone(staffId("housekeeping"), "+5215511110004");
    const messagingQueRompe: WhatsappSenderLike = {
      sendTemplateMessage: vi.fn().mockRejectedValue(new Error("adaptador caído (prueba)")),
    };

    const tool = createHousekeepingTaskTool({ db: engine.admin, messaging: messagingQueRompe, simulated: true });
    const result = await tool.run(ctxFor(hotelId, staffId("gm")), { roomCode, priority: "alta", checklist: [] });

    expect(result.ok).toBe(true);
    const data = result.data as { notificacion: { attempted: boolean; recipients: unknown[] } };
    expect(data.notificacion.attempted).toBe(true);
    expect(data.notificacion.recipients).toHaveLength(0);

    const { rows } = await engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
    expect(rows).toHaveLength(1);
  });
});
