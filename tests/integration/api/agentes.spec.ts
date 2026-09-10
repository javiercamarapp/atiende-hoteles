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

describe("PATCH /hoteles/:hotelId/agentes/:agente/config (transición de gate shadow -> propone -> autopilot)", () => {
  // "enrutador_mensajes" (no es el agente de revenue/cierre): gobernado SOLO por
  // owner/gm, sin el guard extra de founder_decision_approval que sí aplica a
  // "auditor_nocturno" (migración 0081 -- ver describe dedicado más abajo). Usarlo aquí
  // aísla "quién puede tocar el gate + queda auditado" del requisito adicional de
  // aprobación del fundador, que es un mecanismo aparte.
  it("un rol no-admin (frontdesk) NO puede cambiar el gate: 403, config y audit_log intactos", async () => {
    const antes = await fixture.app.request(`/hoteles/${hotelId}/agentes`, { headers: auth(ownerToken) });
    const gateAntes = ((await antes.json()) as Array<{ agente: string; gate: string }>).find(
      (a) => a.agente === "enrutador_mensajes",
    )!.gate;
    expect(gateAntes).toBe("shadow"); // default de código, nadie lo tocó todavía en este archivo

    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(res.status).toBe(403);

    const despues = await fixture.app.request(`/hoteles/${hotelId}/agentes`, { headers: auth(ownerToken) });
    const gateDespues = ((await despues.json()) as Array<{ agente: string; gate: string }>).find(
      (a) => a.agente === "enrutador_mensajes",
    )!.gate;
    expect(gateDespues).toBe("shadow"); // el intento rechazado no movió el gate

    const { rows } = await fixture.engine.admin.query(
      "select id from public.audit_log where hotel_id = $1 and action = 'agent_config.gate_cambiado' and payload->>'agente' = 'enrutador_mensajes';",
      [hotelId],
    );
    expect(rows).toHaveLength(0); // ni siquiera queda un intento fallido en la bitácora
  });

  it("un admin (owner/gm) SÍ puede pasar el gate a 'propone' y a 'autopilot', y cada transición deja bitácora (quién/cuándo/de-qué-a-qué)", async () => {
    const ownerId = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.id;

    const aPropone = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "propone" }),
    });
    expect(aPropone.status).toBe(200);
    expect(((await aPropone.json()) as { gate: string }).gate).toBe("propone");

    const aAutopilot = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(aAutopilot.status).toBe(200);
    expect(((await aAutopilot.json()) as { gate: string }).gate).toBe("autopilot");

    const { rows } = await fixture.engine.admin.query<{
      actor_user_id: string;
      payload: { agente: string; actorRole: string; gateAnterior: string; gateNuevo: string };
      created_at: string;
    }>(
      `select actor_user_id, payload, created_at from public.audit_log
       where hotel_id = $1 and action = 'agent_config.gate_cambiado' and payload->>'agente' = 'enrutador_mensajes'
       order by seq asc;`,
      [hotelId],
    );
    expect(rows).toHaveLength(2); // una fila por transición real de gate, en orden

    expect(rows[0]!.actor_user_id).toBe(ownerId); // QUIÉN
    expect(rows[0]!.created_at).toBeTruthy(); // CUÁNDO (columna propia de audit_log)
    expect(rows[0]!.payload.actorRole).toBe("owner");
    expect(rows[0]!.payload.gateAnterior).toBe("shadow"); // DE
    expect(rows[0]!.payload.gateNuevo).toBe("propone"); // A

    expect(rows[1]!.actor_user_id).toBe(ownerId);
    expect(rows[1]!.payload.gateAnterior).toBe("propone");
    expect(rows[1]!.payload.gateNuevo).toBe("autopilot");
  });

  it("un PATCH que no cambia nada (mismo gate/techo ya vigentes) no agrega ruido a la bitácora append-only", async () => {
    const { rows: antes } = await fixture.engine.admin.query(
      "select count(*)::int as n from public.audit_log where hotel_id = $1 and action = 'agent_config.gate_cambiado' and payload->>'agente' = 'enrutador_mensajes';",
      [hotelId],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "autopilot" }), // ya está en "autopilot" por la prueba anterior
    });
    expect(res.status).toBe(200);

    const { rows: despues } = await fixture.engine.admin.query(
      "select count(*)::int as n from public.audit_log where hotel_id = $1 and action = 'agent_config.gate_cambiado' and payload->>'agente' = 'enrutador_mensajes';",
      [hotelId],
    );
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });

  // "auditor_nocturno" es el ÚNICO agente etiquetado revenue/cierre (agents.ts) --
  // REQ-GOB-012/migración 0081 exige ADEMÁS una aprobación vigente del fundador
  // (`founder_decision_approval`, categoría "shadow_a_autopilot_revenue") antes de
  // aceptar su paso a "autopilot", incluso para un owner/gm real. Antes del mapeo en
  // errors.ts agregado en este mismo cambio, el intento por este endpoint HTTP
  // devolvía un 500 genérico (el trigger de Postgres SÍ bloqueaba la escritura, pero la
  // respuesta no explicaba por qué) -- esta prueba fija el contrato correcto: 409 con
  // `code: "aprobacion_fundador_requerida"`, nunca un 500 opaco.
  it("auditor_nocturno (revenue) a 'autopilot' exige aprobación del fundador incluso para owner: 409 claro sin ella, 200+auditado con ella", async () => {
    const bloqueado = await fixture.app.request(`/hoteles/${hotelId}/agentes/auditor_nocturno/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(bloqueado.status).toBe(409);
    const bodyBloqueado = (await bloqueado.json()) as { code: string };
    expect(bodyBloqueado.code).toBe("aprobacion_fundador_requerida");

    const catalogoAntes = await fixture.app.request(`/hoteles/${hotelId}/agentes`, { headers: auth(ownerToken) });
    const gateAntes = ((await catalogoAntes.json()) as Array<{ agente: string; gate: string }>).find(
      (a) => a.agente === "auditor_nocturno",
    )!.gate;
    expect(gateAntes).toBe("shadow"); // el intento bloqueado no movió el gate

    // Registrar la aprobación del fundador es una operación de PLATAFORMA (0081: sin
    // camino de autoservicio desde ninguna sesión de aplicación) -- se hace directo
    // contra el motor, igual que tests/adversarial/decisiones-reservadas-fundador.spec.ts.
    const founderRows = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`fundador-gate-test-${hotelId}@atiende-hoteles.test`, "Fundador de prueba"],
    );
    const founderId = founderRows.rows[0]!.id;
    await fixture.engine.admin.query("insert into public.founder_identity (user_id, full_name) values ($1, $2);", [
      founderId,
      "Fundador de prueba",
    ]);
    await fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query(
        `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
         values ('shadow_a_autopilot_revenue', $1, $2, $3, $4);`,
        [
          fixture.seed.orgId,
          hotelId,
          founderId,
          "Apruebo el paso de auditor_nocturno a autopilot para este hotel (prueba de integración del endpoint de gate).",
        ],
      ),
    );

    const permitido = await fixture.app.request(`/hoteles/${hotelId}/agentes/auditor_nocturno/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(permitido.status).toBe(200);
    expect(((await permitido.json()) as { gate: string }).gate).toBe("autopilot");

    const { rows } = await fixture.engine.admin.query<{ payload: { gateAnterior: string; gateNuevo: string } }>(
      `select payload from public.audit_log
       where hotel_id = $1 and action = 'agent_config.gate_cambiado' and payload->>'agente' = 'auditor_nocturno';`,
      [hotelId],
    );
    expect(rows).toHaveLength(1); // el intento bloqueado nunca llegó a escribir agent_config, así que no generó bitácora
    expect(rows[0]!.payload.gateAnterior).toBe("shadow");
    expect(rows[0]!.payload.gateNuevo).toBe("autopilot");
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

describe("A5 (auditoria-2 agentico ALTO): el techo mensual por (hotel, agente) es un límite duro bajo concurrencia real", () => {
  it("dos corridas CONCURRENTES del mismo agente, con techo apenas suficiente para UNA, nunca dejan pasar a las dos", async () => {
    // Mide el costo real de una corrida de demo de "enrutador_mensajes" (guion de un
    // solo paso, el más barato del catálogo) con un techo generoso.
    await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ techoMensualUsd: 1000 }),
    });
    const medicion = await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mensaje: "medicion de costo", demo: true }),
    });
    const { costoUsd } = (await medicion.json()) as { costoUsd: number };
    expect(costoUsd).toBeGreaterThan(0);

    // Techo apenas suficiente para 1.5 corridas -- nunca alcanza para 2.
    const techo = Math.round(costoUsd * 1.5 * 1_000_000) / 1_000_000;
    await fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ techoMensualUsd: techo }),
    });
    // Reinicia el consumo del mes para este agente (deja solo las corridas de ESTA prueba).
    await fixture.engine.admin.query(
      "delete from public.agent_run where hotel_id = $1 and agent_name = 'enrutador_mensajes';",
      [hotelId],
    );

    const dispararDemo = () =>
      fixture.app.request(`/hoteles/${hotelId}/agentes/enrutador_mensajes/ejecutar`, {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ mensaje: "consulta concurrente", demo: true }),
      });

    const [resA, resB] = await Promise.all([dispararDemo(), dispararDemo()]);
    const [bodyA, bodyB] = (await Promise.all([resA.json(), resB.json()])) as [{ estado: string }, { estado: string }];
    const bloqueadas = [bodyA, bodyB].filter((b) => b.estado === "presupuesto_agotado");
    const completadas = [bodyA, bodyB].filter((b) => b.estado !== "presupuesto_agotado");

    // Sin el lock, ambas podían leer "restante > 0" antes de que cualquiera
    // registrara su gasto y las DOS pasaban -- con el fix, como máximo una completa.
    expect(completadas.length).toBeLessThanOrEqual(1);
    expect(bloqueadas.length).toBeGreaterThanOrEqual(1);

    const { rows: gastoTotal } = await fixture.engine.admin.query<{ total: string }>(
      "select coalesce(sum(cost_usd), 0)::text as total from public.agent_run where hotel_id = $1 and agent_name = 'enrutador_mensajes';",
      [hotelId],
    );
    // El gasto total real NUNCA rebasa el techo configurado.
    expect(Number(gastoTotal[0]!.total)).toBeLessThanOrEqual(techo + 1e-6);
  });

  it("lock_agent_budget() serializa dos sesiones reales y distintas del MISMO (hotel, agente): la segunda espera a que la primera comitee", async () => {
    // Prueba directa del mecanismo (mismo patrón que night_audit_claim/
    // lock_agent_approval_key): dos sesiones físicas reales, la primera sostiene el
    // lock deliberadamente (pg_sleep DENTRO de su propia transacción, sobre el MISMO
    // par hotel+agente) para forzar un entrelazado determinista -- sin esto, contra un
    // embedded-postgres local en loopback las dos transacciones a veces terminan sin
    // llegar a solaparse nunca (mismo problema documentado para otras pruebas de
    // concurrencia de este lote).
    const eventos: string[] = [];
    const ownerId = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.id;

    const sesionA = fixture.engine.withAppSession({ userId: ownerId }, async (session) => {
      await session.query("select public.lock_agent_budget($1, $2);", [hotelId, "lock-test-agent"]);
      eventos.push("A:lock-adquirido");
      await session.query("select pg_sleep(0.15);");
      eventos.push("A:antes-de-comitear");
    });

    await new Promise((resolve) => setTimeout(resolve, 20)); // deja que A tome el lock primero
    const sesionB = fixture.engine.withAppSession({ userId: ownerId }, async (session) => {
      eventos.push("B:intentando-lock");
      await session.query("select public.lock_agent_budget($1, $2);", [hotelId, "lock-test-agent"]);
      eventos.push("B:lock-adquirido");
    });

    await Promise.all([sesionA, sesionB]);

    // B solo pudo adquirir el lock DESPUÉS de que A llegó al punto justo antes de su
    // propio commit (la transacción de A sigue abierta durante el pg_sleep) -- prueba
    // directa de que el advisory lock sí bloquea a la segunda sesión.
    expect(eventos.indexOf("B:lock-adquirido")).toBeGreaterThan(eventos.indexOf("A:antes-de-comitear"));
  });
});
