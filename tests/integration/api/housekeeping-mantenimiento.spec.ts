// H6b · /housekeeping y /mantenimiento vía la API real (REQ-HK-001/002/003/011/013/014):
// tablero, ciclo de vida de una tarea de housekeeping, y ciclo de vida de un ticket de
// mantenimiento incluida la autorización de gasto con doble confirmación de DOS actores
// reales (owner + gm) a través de /aprobaciones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_SEED_PASSWORD, hashPassword } from "@atiende-hoteles/db";
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

  it("backend ALTO/CRÍTICO: un segundo 'owner' NO puede completar la doble confirmación mintiendo su rol en el body -- el rol SIEMPRE sale de la sesión real (GOB-026)", async () => {
    // Segundo owner REAL del mismo hotel (dos co-propietarios, escenario realista) --
    // el hallazgo es que, ANTES del fix, un segundo actor con el MISMO rol real podía
    // mandar {"role":"gm"} en el body y colarse como si fuera un segundo nivel
    // jerárquico distinto, vaciando la exigencia de "dos ROLES distintos" de GOB-026.
    const passwordHash = await hashPassword(DEV_SEED_PASSWORD);
    const { rows: owner2Rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ($1, 'Segundo Propietario', $2) returning id;",
      [`owner2-role-test@example.com`, passwordHash],
    );
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');",
      [fixture.seed.orgId, hotelId, owner2Rows[0]!.id],
    );
    const owner2Token = await loginAs(fixture.app, "owner2-role-test@example.com");

    const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, title: "Filtro de agua dañado", description: "El filtro gotea.", severity: "media", estimatedCost: 3000 }),
    });
    const { ticketId } = (await crearTicket.json()) as { ticketId: string };
    const cerrar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ actualCost: 2900 }),
    });
    const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

    // Primer owner confirma con su rol real.
    const primera = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
    });
    expect(primera.status).toBe(200);
    expect(((await primera.json()) as { estado: string }).estado).toBe("pendiente");

    // "role" en el body es un campo desconocido ahora (`.strict()`) -- 400 explícito,
    // nunca se usa en silencio para suplantar un rol distinto al real de sesión.
    const intentoConRoleFalso = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(owner2Token), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo.", role: "gm" }),
    });
    expect(intentoConRoleFalso.status).toBe(400);

    // Sin mentir sobre el rol, el segundo owner (MISMO rol real que el primero) NO
    // logra completar la doble confirmación -- GOB-026 exige un rol real distinto.
    const segundaConRolReal = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(owner2Token), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
    });
    expect(segundaConRolReal.status).toBe(409);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(rows[0]!.status).not.toBe("cerrado"); // nunca se ejecutó
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

  it("A2/CRÍTICO: bajar el agente a 'shadow' DESPUÉS de pedir la aprobación detiene la ejecución diferida (freno de emergencia real)", async () => {
    // Agente en autopilot: una acción de dinero que propuso llega a la cola de
    // aprobación normal.
    await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ gate: "autopilot" }),
    });

    const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ roomCode, title: "Fuga menor", description: "Fuga menor bajo el fregadero.", severity: "baja" }),
    });
    const { ticketId } = (await crearTicket.json()) as { ticketId: string };

    // Solicitud de aprobación ORIGINADA POR UN AGENTE (requestedBy con el prefijo
    // "agent:recepcion_virtual:..." que usa runner.ts) -- a diferencia de
    // "cerrar-con-costo" (que la pide un staff directamente), esta SÍ está gobernada
    // por el gate del agente.
    const { rows: aprobacionRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.agent_approval
         (org_id, hotel_id, tool_name, input_hash, input_summary, texto_mostrado, requested_by,
          is_money, required_confirmations, status, requested_at, expires_at, input_json)
       values ($1, $2, 'autorizar_gasto_mantenimiento', 'hash-a2-test', 'resumen', 'autorizar 900 MXN',
               'agent:recepcion_virtual:staff-huesped-1', true, 2, 'pendiente', now(), now() + interval '15 minutes',
               $3::jsonb)
       returning id;`,
      [fixture.seed.orgId, hotelId, JSON.stringify({ ticketId, actualCost: 900 })],
    );
    const aprobacionId = aprobacionRows[0]!.id;

    // Primera confirmación (gm) -- sigue pendiente, sin ejecutar nada todavía.
    const primera = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "autorizar 900 MXN" }),
    });
    expect(primera.status).toBe(200);
    expect(((await primera.json()) as { estado: string }).estado).toBe("pendiente");

    // El gerente ve algo raro y BAJA el agente a shadow como freno de emergencia --
    // la solicitud ya está en la cola, a una sola confirmación de ejecutarse.
    const bajarGate = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ gate: "shadow" }),
    });
    expect(bajarGate.status).toBe(200);

    // Segunda confirmación (owner) -- completa la doble confirmación (GOB-026), pero
    // el gate YA es "shadow": la ejecución debe detenerse aquí, no correr "igual que
    // si el gate siguiera en autopilot".
    const segunda = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...authOf(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "autorizar 900 MXN" }),
    });
    expect(segunda.status).toBe(200);
    const segundaBody = (await segunda.json()) as { estado: string; ejecutado: boolean };
    expect(segundaBody.ejecutado).toBe(false);
    expect(segundaBody.estado).toBe("bloqueada_por_gate_shadow");

    // El ticket NUNCA se cerró/cobró -- el freno de emergencia sí detuvo el efecto real.
    const { rows: ticketRows } = await fixture.engine.admin.query<{ status: string; actual_cost: string | null }>(
      "select status, actual_cost from public.maintenance_ticket where id = $1;",
      [ticketId],
    );
    expect(ticketRows[0]!.status).not.toBe("cerrado");
    expect(ticketRows[0]!.actual_cost).toBeNull();

    // La aprobación en sí quedó "aprobada" (la doble confirmación humana SÍ se
    // completó) pero nunca "ejecutada" -- queda disponible para reintentarse si el
    // gate vuelve a subir, en vez de perderse en silencio.
    const { rows: aprobacionFinal } = await fixture.engine.admin.query<{ status: string; ejecutada_en: string | null }>(
      "select status, ejecutada_en from public.agent_approval where id = $1;",
      [aprobacionId],
    );
    expect(aprobacionFinal[0]!.status).toBe("aprobada");
    expect(aprobacionFinal[0]!.ejecutada_en).toBeNull();
  });

  describe("A6 (auditoria-2 agentico ALTO): segundo aprobador delegado para hoteles de un solo administrador", () => {
    it("sin delegado configurado: un no-admin (housekeeping) NO puede decidir (403), igual que antes", async () => {
      const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
        method: "POST",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ roomCode, title: "Prueba delegado sin config", description: "x", severity: "media", estimatedCost: 1000 }),
      });
      const { ticketId } = (await crearTicket.json()) as { ticketId: string };
      const cerrar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
        method: "POST",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ actualCost: 900 }),
      });
      const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

      const intento = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: { ...authOf(housekeepingToken), "content-type": "application/json" },
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
      });
      expect(intento.status).toBe(403);
    });

    it("owner designa a maintenance como delegado -> maintenance SÍ puede completar la segunda confirmación (rol real distinto, GOB-026 intacto)", async () => {
      // El delegado debe poder ejecutar de verdad el EFECTO de la tool aprobada
      // (`autorizar_gasto_mantenimiento` escribe `maintenance_ticket` bajo la RLS del
      // PROPIO delegado, no de "sistema") -- la RLS de `maintenance_ticket` solo
      // permite escribir a owner/gm o al técnico de mantenimiento ASIGNADO al ticket,
      // así que se usa "maintenance" (asignado al ticket) como delegado, no
      // housekeeping (que nunca podría escribir ese ticket aunque decidiera la
      // aprobación).
      const maintenanceStaff = fixture.seed.hotels[0]!.staff.find((s) => s.role === "maintenance")!;
      const maintenanceToken = await loginAs(fixture.app, maintenanceStaff.email);

      // Sin ser owner/gm, no puede auto-designarse.
      const intentoNoAutorizado = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, {
        method: "PUT",
        headers: { ...authOf(maintenanceToken), "content-type": "application/json" },
        body: JSON.stringify({ userId: maintenanceStaff.id }),
      });
      expect(intentoNoAutorizado.status).toBe(403);

      // owner designa a maintenance como segundo aprobador delegado.
      const designar = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, {
        method: "PUT",
        headers: { ...authOf(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({ userId: maintenanceStaff.id }),
      });
      expect(designar.status).toBe(200);

      const consulta = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, { headers: authOf(gmToken) });
      const { delegado } = (await consulta.json()) as { delegado: { userId: string } | null };
      expect(delegado?.userId).toBe(maintenanceStaff.id);

      // Ticket de mantenimiento, asignado al técnico delegado -> primera confirmación
      // (gm) -> segunda confirmación por el DELEGADO (rol real "maintenance",
      // distinto de "gm").
      const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
        method: "POST",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ roomCode, title: "Prueba delegado", description: "x", severity: "media", estimatedCost: 1200 }),
      });
      const { ticketId } = (await crearTicket.json()) as { ticketId: string };
      const asignar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/asignar`, {
        method: "PATCH",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: maintenanceStaff.id }),
      });
      expect(asignar.status).toBe(200);
      const { rows: asignadoRows } = await fixture.engine.admin.query<{ assigned_to: string | null }>(
        "select assigned_to from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(asignadoRows[0]!.assigned_to).toBe(maintenanceStaff.id);

      const cerrar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
        method: "POST",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ actualCost: 1150 }),
      });
      const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

      const primera = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: { ...authOf(gmToken), "content-type": "application/json" },
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo." }),
      });
      expect(primera.status).toBe(200);
      expect(((await primera.json()) as { estado: string }).estado).toBe("pendiente");

      const segunda = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: { ...authOf(maintenanceToken), "content-type": "application/json" },
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo como delegado." }),
      });
      expect(segunda.status).toBe(200);
      const segundaBody = (await segunda.json()) as { estado: string; ejecutado: boolean };
      expect(segundaBody.estado).toBe("aprobada");
      expect(segundaBody.ejecutado).toBe(true);

      const { rows } = await fixture.engine.admin.query<{ status: string; actual_cost: string }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(rows[0]!.status).toBe("cerrado");
      expect(Number(rows[0]!.actual_cost)).toBe(1150);

      // Solo owner/gm pueden revocar.
      const revocarNoAutorizado = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, {
        method: "DELETE",
        headers: authOf(housekeepingToken),
      });
      expect(revocarNoAutorizado.status).toBe(403);

      const revocar = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, {
        method: "DELETE",
        headers: authOf(ownerToken),
      });
      expect(revocar.status).toBe(200);
      const consultaFinal = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/delegado`, { headers: authOf(gmToken) });
      expect(((await consultaFinal.json()) as { delegado: unknown }).delegado).toBeNull();
    });
  });
});
