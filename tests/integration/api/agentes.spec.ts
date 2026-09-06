// H7 · Integración: runtime de agentes por rol conectado a la API real (embedded-postgres),
// presupuesto/costo por hotel, roi_event y trazas de agente en audit_log -- ENTREGA punto 5
// "integración (agent_run + audit_log encadenado en la misma transacción; presupuesto
// agotado bloquea escritura)".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

let fixture: ApiFixture;
let hotelId: string;
let ownerToken: string;
let frontdeskToken: string;

beforeAll(async () => {
  fixture = await createApiFixture();
  hotelId = fixture.seed.hotels[0]!.id;
  const hotelSlug = fixture.seed.hotels[0]!.staff[0]!.email.split("@")[1]!.replace(".demo", "");
  ownerToken = await loginAs(fixture.app, `owner@${hotelSlug}.demo`);
  frontdeskToken = await loginAs(fixture.app, `frontdesk@${hotelSlug}.demo`);
});

afterAll(async () => {
  await destroyApiFixture(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("GET /hoteles/:hotelId/agentes", () => {
  it("lista el catálogo con gate/techo por default (sin agent_config todavía)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes`, { headers: auth(frontdeskToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ agente: string; gate: string; techoMensualUsd: number }>;
    expect(body.map((a) => a.agente).sort()).toEqual(["auditor_nocturno", "enrutador_mensajes", "recepcion_virtual"]);
    for (const a of body) expect(a.gate).toBe("shadow");
  });
});

describe("POST /hoteles/:hotelId/agentes/:agente/ejecutar (demo)", () => {
  it("shadow: completa sin ejecutar tools de escritura, inserta agent_run + audit_log en la misma transacción", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mensaje: "Huésped reporta AC descompuesto al hacer check-in.", demo: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; simulado: boolean; runId: string; gate: string };
    expect(body.estado).toBe("completado");
    expect(body.simulado).toBe(true);
    expect(body.gate).toBe("shadow");

    const { rows: runs } = await fixture.engine.admin.query<{ run_id: string; status: string; gate: string }>(
      "select run_id, status, gate from public.agent_run where hotel_id = $1 and run_id = $2;",
      [hotelId, body.runId],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completado");

    const { rows: auditRows } = await fixture.engine.admin.query<{ action: string }>(
      `select action from public.audit_log where hotel_id = $1 and payload->>'runId' = $2 order by seq asc;`,
      [hotelId, body.runId],
    );
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows.some((r) => r.action === "agente.run_started")).toBe(true);
    expect(auditRows.some((r) => r.action === "agente.run_finished")).toBe(true);

    // Shadow: ninguna tarea/ticket real se crea (AgentRunner las omite por gate).
    const { rows: tasks } = await fixture.engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
    expect(tasks).toHaveLength(0);
  });

  it("no acepta hotelId/gate/orgId en el cuerpo (input del cliente nunca fija identidad/gate)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mensaje: "hola", demo: true, gate: "autopilot", hotelId: "otro-hotel" }),
    });
    expect(res.status).toBe(400);
  });

  it("presupuesto agotado corta ANTES de invocar al proveedor y bloquea la escritura (agent_run costo 0, sin pasos)", async () => {
    const cfgRes = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ techoMensualUsd: 0 }),
    });
    expect(cfgRes.status).toBe(200);

    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mensaje: "¿Tienen alberca?", demo: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; simulado: boolean };
    expect(body.estado).toBe("presupuesto_agotado");
    expect(body.simulado).toBe(false);

    const { rows } = await fixture.engine.admin.query<{ status: string; cost_usd: string; steps: number }>(
      "select status, cost_usd, steps from public.agent_run where hotel_id = $1 and agent_name = 'enrutador_mensajes' order by created_at desc limit 1;",
      [hotelId],
    );
    expect(rows[0]!.status).toBe("presupuesto_agotado");
    expect(Number(rows[0]!.cost_usd)).toBe(0);
    expect(rows[0]!.steps).toBe(0);
  });

  it("sin demo (proveedor real sin credenciales): se declara no_configurado, nunca una respuesta simulada como si fuera real", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mensaje: "hola" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; simulado: boolean };
    expect(body.estado).toBe("no_configurado");
    expect(body.simulado).toBe(false);
  });
});

describe("GET /hoteles/:hotelId/agentes/costos", () => {
  it("refleja el costo acumulado del mes contra el techo configurado", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/costos`, { headers: auth(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ agente: string; consumidoUsd: number; techoMensualUsd: number; sinDatos: boolean }>;
    const enrutador = body.find((a) => a.agente === "enrutador_mensajes")!;
    expect(enrutador.techoMensualUsd).toBe(0);
    expect(enrutador.sinDatos).toBe(false); // ya tiene un intento registrado (costo 0, pero hay fila)
  });
});

describe("GET /hoteles/:hotelId/roi", () => {
  it("expone los eventos de ROI registrados con su supuesto versionado", async () => {
    // A1 (auditoria-2 agentico CRÍTICO): una demo SIEMPRE fuerza gate "shadow" (ver
    // prueba dedicada más abajo), así que ya no sirve para poblar datos reales de ROI
    // en esta prueba -- se siembra el evento directo en BD (lo que en producción
    // insertaría `registrar_evento_roi` en una corrida REAL, no de demo) para probar
    // exclusivamente el endpoint de lectura.
    await fixture.engine.admin.query(
      `insert into public.roi_event
         (org_id, hotel_id, agent_name, tipo_evento, monto_estimado, metodo_contrafactual, confianza, supuesto_version, referencia_tipo)
       values ($1, $2, 'auditor_nocturno', 'revenue_ajuste_nocturno_detectado', 42, 'metodo de prueba', 0.5, 'H17-v1', 'ninguna');`,
      [fixture.seed.orgId, hotelId],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/roi`, { headers: auth(ownerToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eventos: Array<{ estimado: boolean; supuestoVersion: string }>; sinDatos: boolean; sumaEstimadoUsd: number };
    expect(body.sinDatos).toBe(false);
    expect(body.eventos.length).toBeGreaterThan(0);
    expect(body.eventos[0]!.estimado).toBe(true);
    expect(body.eventos[0]!.supuestoVersion).toBe("H17-v1");
    expect(body.sumaEstimadoUsd).toBeGreaterThan(0);
  });
});

describe("A1 (auditoria-2 agentico CRÍTICO): la demo SIEMPRE corre en gate shadow, sin importar el gate real configurado", () => {
  it("un hotel/agente en gate 'autopilot' que corre demo:true NO ejecuta ningún efecto real (ni tarea, ni ticket, ni ROI, ni fuera de servicio)", async () => {
    // El GM sube el agente a autopilot (el paso normal para pasar a producción) --
    // ANTES del fix, una demo en este estado ejecutaba las tools de verdad, incluida
    // `crear_ticket_mantenimiento` con severity:"alta" (marca una habitación fuera de
    // servicio) sobre el primer cuarto REAL del hotel.
    const cfgRes = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(cfgRes.status).toBe(200);

    const { rows: roomsAntes } = await fixture.engine.admin.query<{ id: string; status: string }>(
      "select id, status from public.room where hotel_id = $1;",
      [hotelId],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ mensaje: "Huésped reporta AC descompuesto al hacer check-in.", demo: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; simulado: boolean; gate: string };
    expect(body.estado).toBe("completado");
    expect(body.simulado).toBe(true);
    // El gate EFECTIVO de esta corrida (lo que de verdad gobernó la ejecución) es
    // "shadow", aunque el hotel esté configurado en "autopilot" -- la respuesta no
    // debe aparentar que corrió con el gate real.
    expect(body.gate).toBe("shadow");

    // Ninguna habitación real cambió de estado (el hallazgo original: una demo podía
    // marcar el primer cuarto real del hotel como fuera de servicio).
    const { rows: roomsDespues } = await fixture.engine.admin.query<{ id: string; status: string }>(
      "select id, status from public.room where hotel_id = $1;",
      [hotelId],
    );
    expect(roomsDespues).toEqual(roomsAntes);
    expect(roomsDespues.every((r) => r.status !== "fuera_de_servicio")).toBe(true);

    // Ninguna tarea/ticket/mensaje/evento de ROI real se creó.
    const { rows: tasks } = await fixture.engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
    expect(tasks).toHaveLength(0);
    const { rows: tickets } = await fixture.engine.admin.query("select id from public.maintenance_ticket where hotel_id = $1;", [hotelId]);
    expect(tickets).toHaveLength(0);
    const { rows: messages } = await fixture.engine.admin.query("select id from public.message where hotel_id = $1;", [hotelId]);
    expect(messages).toHaveLength(0);
    const { rows: roiEvents } = await fixture.engine.admin.query(
      "select id from public.roi_event where hotel_id = $1 and agent_name = 'recepcion_virtual';",
      [hotelId],
    );
    expect(roiEvents).toHaveLength(0);

    // El propio `agent_run` guarda el gate EFECTIVO (shadow), no el gate real del
    // hotel (autopilot) -- el registro de auditoría no debe sugerir que la corrida
    // gobernó con el gate de producción.
    const { rows: runs } = await fixture.engine.admin.query<{ gate: string }>(
      "select gate from public.agent_run where hotel_id = $1 and agent_name = 'recepcion_virtual' order by created_at desc limit 1;",
      [hotelId],
    );
    expect(runs[0]!.gate).toBe("shadow");
  });
});
