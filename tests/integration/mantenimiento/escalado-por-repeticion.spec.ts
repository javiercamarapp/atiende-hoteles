// REQ-HK-012 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe enriquecer cada
// ticket con el historial del activo asociado, escalando automáticamente tras N tickets
// repetidos en X días sobre el mismo activo." Criterio de aceptación LITERAL: "Ticket
// enriquecido con historial del activo asociado; N tickets repetidos en X días
// (configurable) sobre el mismo activo escalan automáticamente (verificado con N+1
// repeticiones)." Depende de credenciales: No.
//
// Contra embedded-postgres real (ADR-003), vía la API real
// (`POST /hoteles/:hotelId/mantenimiento`, la MISMA tool de dominio
// `crear_ticket_mantenimiento` que usaría el agente conversacional -- ver
// packages/agent-core/src/tools/housekeepingTools.ts) -- sin ningún doble de prueba de
// canal externo: crear un ticket de mantenimiento NUNCA depende de WhatsApp/Meta (el
// adaptador simulado ya cubre esa parte, ver housekeeping-mantenimiento.spec.ts).
//
// Cada `it` crea SU PROPIO activo (mismo criterio de aislamiento por escenario que
// tests/integration/tickets/sla-escalado.spec.ts) para que los tickets de un escenario
// nunca contaminen el conteo "N repetidos en X días" de otro.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface TicketApiRow {
  id: string;
  assetId: string | null;
  assetCode: string | null;
  titulo: string;
  estado: string;
  escaladoEn: string | null;
  escaladoARoles: string[];
}

describe("REQ-HK-012: historial de activo + escalación automática por repetición", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let ownerToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    tenantId = fixture.seed.orgId;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  beforeEach(async () => {
    await fixture.engine.admin.exec(
      "truncate table public.maintenance_ticket, public.maintenance_asset, public.maintenance_escalation_policy, public.audit_log restart identity cascade;",
    );
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  async function crearActivo(code: string, name = "Minisplit"): Promise<{ id: string; code: string }> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ code, name }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; code: string };
  }

  async function reportarTicket(
    assetCode: string,
    titulo: string,
    token: string = gmToken,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: authOf(token),
      body: JSON.stringify({
        assetCode,
        title: titulo,
        description: `Falla reportada: ${titulo}.`,
        severity: "media",
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function listarTickets(): Promise<TicketApiRow[]> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, { headers: authOf(gmToken) });
    expect(res.status).toBe(200);
    return (await res.json()) as TicketApiRow[];
  }

  it("con MENOS del umbral (N-1) de tickets repetidos, el activo NO escala (caso negativo, política default N=3)", async () => {
    const activo = await crearActivo("AC-204");

    const t1 = await reportarTicket(activo.code, "No enfría");
    expect(t1.status).toBe(201);
    expect(t1.body.escalado).toBe(false);

    const t2 = await reportarTicket(activo.code, "Hace ruido");
    expect(t2.status).toBe(201);
    expect(t2.body.escalado).toBe(false);

    const tickets = await listarTickets();
    expect(tickets.every((t) => t.escaladoEn === null)).toBe(true);

    const { rows: auditRows } = await fixture.engine.admin.query(
      "select id from public.audit_log where hotel_id = $1 and action = 'maintenance_ticket.escalado_por_repeticion';",
      [hotelId],
    );
    expect(auditRows).toHaveLength(0);
  });

  it("al llegar al umbral N y con N+1 repeticiones, el activo escala automáticamente (política default N=3/14 días)", async () => {
    const activo = await crearActivo("AC-305");

    const t1 = await reportarTicket(activo.code, "No enfría");
    expect(t1.body.escalado).toBe(false);
    const t2 = await reportarTicket(activo.code, "Hace ruido");
    expect(t2.body.escalado).toBe(false);

    // Tercer ticket (N=3): alcanza el umbral exacto -- ya escala.
    const t3 = await reportarTicket(activo.code, "Fuga de agua del condensado");
    expect(t3.status).toBe(201);
    expect(t3.body.escalado).toBe(true);
    expect(t3.body.escaladoARoles).toEqual(["gm", "owner"]);
    // Historial enriquecido: al momento del 3er ticket, el activo ya tiene 2 tickets
    // previos (REQ-HK-012 "enriquecer cada ticket con el historial del activo
    // asociado").
    expect(t3.body.assetHistorial).toHaveLength(2);
    const titulosHistorial = (t3.body.assetHistorial as { title: string }[]).map((h) => h.title);
    expect(titulosHistorial).toEqual(["Hace ruido", "No enfría"]); // más reciente primero

    // Cuarto ticket (N+1 = 4, el caso explícito del criterio de aceptación): sigue
    // escalando, y el historial ahora trae los 3 anteriores.
    const t4 = await reportarTicket(activo.code, "Olor a quemado");
    expect(t4.status).toBe(201);
    expect(t4.body.escalado).toBe(true);
    expect(t4.body.assetHistorial).toHaveLength(3);

    const tickets = await listarTickets();
    const t3Row = tickets.find((t) => t.id === (t3.body.ticketId as string))!;
    const t4Row = tickets.find((t) => t.id === (t4.body.ticketId as string))!;
    expect(t3Row.escaladoEn).not.toBeNull();
    expect(t3Row.escaladoARoles).toEqual(["gm", "owner"]);
    expect(t4Row.escaladoEn).not.toBeNull();
    expect(t3Row.assetCode).toBe(activo.code);

    // Bitácora de auditoría real (mismo patrón que la escalación por SLA de
    // guest_ticket): una entrada por CADA ticket que escaló (2: el 3ro y el 4to).
    // El payload real lo arma `recordToolAudit()` (packages/agent-core/src/audit.ts):
    // envuelve `after` (nuestro objeto con `ticketsEnVentana`) bajo `valorNuevo`, junto
    // con `agente`/`valorAnterior` -- mismo formato que usa CUALQUIER tool auditada
    // (REQ-AGT-001), no uno propio de esta escalación.
    const { rows: auditRows } = await fixture.engine.admin.query<{
      payload: { valorNuevo: { ticketsEnVentana: number }; agente: { toolName: string } };
    }>(
      "select payload from public.audit_log where hotel_id = $1 and action = 'maintenance_ticket.escalado_por_repeticion' order by created_at asc;",
      [hotelId],
    );
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]!.payload.valorNuevo.ticketsEnVentana).toBe(3);
    expect(auditRows[1]!.payload.valorNuevo.ticketsEnVentana).toBe(4);
    expect(auditRows[0]!.payload.agente.toolName).toBe("crear_ticket_mantenimiento");
  });

  it("activos DISTINTOS no comparten el conteo de repeticiones (caso negativo: no escala por contaminación cruzada)", async () => {
    const activoA = await crearActivo("AC-101", "Minisplit 101");
    const activoB = await crearActivo("AC-102", "Minisplit 102");

    // 2 tickets en cada activo (por debajo del umbral default de 3) -- 4 tickets en
    // total, pero NINGUNO de los dos activos individualmente llega a 3.
    await reportarTicket(activoA.code, "No enfría A");
    const a2 = await reportarTicket(activoA.code, "Hace ruido A");
    await reportarTicket(activoB.code, "No enfría B");
    const b2 = await reportarTicket(activoB.code, "Hace ruido B");

    expect(a2.body.escalado).toBe(false);
    expect(b2.body.escalado).toBe(false);
    expect(a2.body.assetHistorial).toHaveLength(1);
    expect(b2.body.assetHistorial).toHaveLength(1);
  });

  it("tickets FUERA de la ventana de días no cuentan para la escalación (caso negativo: ventana de tiempo real)", async () => {
    const activo = await crearActivo("AC-503");

    // 3 tickets sembrados directamente hace 30 días (fuera de la ventana default de 14
    // días) -- si el conteo ignorara la ventana, cualquier ticket nuevo escalaría de
    // inmediato solo por existir estos 3 antiguos.
    for (let i = 0; i < 3; i++) {
      await fixture.engine.admin.query(
        `insert into public.maintenance_ticket
           (tenant_id, hotel_id, asset_id, title, description, origin, severity, created_at)
         values ($1, $2, $3, $4, 'Falla antigua fuera de ventana.', 'staff', 'media', now() - interval '30 days');`,
        [tenantId, hotelId, activo.id, `Falla antigua ${i}`],
      );
    }

    const nuevo = await reportarTicket(activo.code, "Falla reciente 1");
    expect(nuevo.body.escalado).toBe(false); // solo 1 ticket dentro de la ventana (el propio)

    // Con 2 más DENTRO de la ventana sí alcanza el umbral (3 dentro de la ventana,
    // ignorando por completo los 3 antiguos).
    await reportarTicket(activo.code, "Falla reciente 2");
    const tercero = await reportarTicket(activo.code, "Falla reciente 3");
    expect(tercero.body.escalado).toBe(true);
  });

  it("respeta la política de escalación CONFIGURADA por el hotel (N/X propios) en vez del default", async () => {
    await fixture.engine.admin.query(
      `insert into public.maintenance_escalation_policy (tenant_id, hotel_id, threshold_count, window_days)
       values ($1, $2, 2, 7);`,
      [tenantId, hotelId],
    );
    const activo = await crearActivo("BOMBA-ALBERCA");

    const t1 = await reportarTicket(activo.code, "No enciende");
    expect(t1.body.escalado).toBe(false); // umbral configurado = 2, todavía 1

    const t2 = await reportarTicket(activo.code, "Fuga en la bomba");
    expect(t2.body.escalado).toBe(true); // alcanza el umbral configurado de 2
  });

  it("GET .../activos/:assetId/historial devuelve el historial completo y la política de escalación efectiva", async () => {
    const activo = await crearActivo("ELEV-01", "Elevador principal");
    await reportarTicket(activo.code, "Se atora en el piso 3");
    await reportarTicket(activo.code, "Puerta no cierra bien");

    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos/${activo.id}/historial`, {
      headers: authOf(gmToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activo: { code: string };
      politicaEscalacion: { umbral: number; ventanaDias: number };
      historial: { titulo: string }[];
    };
    expect(body.activo.code).toBe("ELEV-01");
    expect(body.politicaEscalacion).toEqual({ umbral: 3, ventanaDias: 14 }); // default, sin política propia
    expect(body.historial).toHaveLength(2);
    expect(body.historial[0]!.titulo).toBe("Puerta no cierra bien"); // más reciente primero
  });

  it("un ticket SIN assetCode se comporta exactamente igual que antes (sin historial/escalación) -- no rompe REQ-HK-011", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ title: "Pasillo huele raro", description: "Sin activo asociado.", severity: "baja" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.assetId).toBeUndefined();
    expect(body.escalado).toBeUndefined();
  });

  it("reportar un ticket con un assetCode inexistente falla con 400 y no crea nada (caso negativo)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ assetCode: "NO-EXISTE", title: "x", description: "x" }),
    });
    expect(res.status).toBe(400);
    const tickets = await listarTickets();
    expect(tickets).toHaveLength(0);
  });

  it("housekeeping puede REPORTAR un ticket sobre un activo existente pero NO puede dar de alta activos nuevos (RLS/rol)", async () => {
    const activo = await crearActivo("AC-701");

    const reportado = await reportarTicket(activo.code, "Reportado por camarista", housekeepingToken);
    expect(reportado.status).toBe(201);

    const altaProhibida = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ code: "AC-999", name: "Otro" }),
    });
    expect(altaProhibida.status).toBe(403);
  });

  it("owner también puede consultar el catálogo de activos (GET, cualquier staff del hotel)", async () => {
    await crearActivo("AC-900");
    const res = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/activos`, { headers: authOf(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string }[];
    expect(body.some((a) => a.code === "AC-900")).toBe(true);
  });
});
