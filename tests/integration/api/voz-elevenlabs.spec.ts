// fix/voz-elevenlabs · Webhook real de ElevenLabs Conversational AI para
// `recepcion_virtual` (ver apps/api/src/routes/vozElevenlabs.ts y
// docs/agente-voz/README.md): autenticación por secreto POR HOTEL, gate
// shadow/propone/autopilot del hotel sigue aplicando exactamente igual que dentro de
// AgentRunner, y `enviar_mensaje_whatsapp_plantilla` SIEMPRE cae en aprobación humana
// para este canal (nunca auto-aprobación de plantilla transaccional, a diferencia de
// WhatsApp) porque este webhook no tiene un teléfono de huésped verificado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: voz (ElevenLabs) — webhook de tools + config (integración real)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let otroHotelId: string;
  let roomCode: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    const otroHotel = fixture.seed.hotels[1]!;
    hotelId = hotel.id;
    otroHotelId = otroHotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 1;",
      [hotelId],
    );
    roomCode = rows[0]!.code;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  async function getConfig(token: string) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/voz/config`, { headers: auth(token) });
    expect(res.status).toBe(200);
    return (await res.json()) as { toolWebhookSecret: string; habilitado: boolean; gateRecepcionVirtual: string };
  }

  async function llamarTool(
    toolName: string,
    secret: string | undefined,
    body: Record<string, unknown>,
    hotel: string = hotelId,
  ) {
    return fixture.app.request(`/hoteles/${hotel}/voz/webhook/${toolName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-atiende-voz-tool-secret": secret } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  describe("config (staff autenticado)", () => {
    it("frontdesk no puede leer ni escribir la config (secreto sensible, solo owner/gm)", async () => {
      const get = await fixture.app.request(`/hoteles/${hotelId}/voz/config`, { headers: auth(frontdeskToken) });
      expect(get.status).toBe(403);

      const patch = await fixture.app.request(`/hoteles/${hotelId}/voz/config`, {
        method: "PATCH",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ habilitado: true }),
      });
      expect(patch.status).toBe(403);
    });

    it("owner activa el agente y fija el elevenlabs_agent_id", async () => {
      const patch = await fixture.app.request(`/hoteles/${hotelId}/voz/config`, {
        method: "PATCH",
        headers: auth(ownerToken),
        body: JSON.stringify({ habilitado: true, elevenlabsAgentId: "agent_demo_hotel_centro" }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as { habilitado: boolean; elevenlabsAgentId: string };
      expect(body.habilitado).toBe(true);
      expect(body.elevenlabsAgentId).toBe("agent_demo_hotel_centro");
    });
  });

  describe("autenticación del webhook", () => {
    it("tool desconocida -> 404", async () => {
      const config = await getConfig(ownerToken);
      const res = await llamarTool("tool-inventada", config.toolWebhookSecret, {});
      expect(res.status).toBe(404);
    });

    it("sin secreto -> 401", async () => {
      const res = await llamarTool("crear-tarea-housekeeping", undefined, { roomCode });
      expect(res.status).toBe(401);
    });

    it("secreto incorrecto -> 401", async () => {
      const res = await llamarTool("crear-tarea-housekeeping", "secreto-equivocado", { roomCode });
      expect(res.status).toBe(401);
    });

    it("el secreto de OTRO hotel no funciona contra este hotel (aislamiento por tenant)", async () => {
      const otroGmToken = await loginAs(fixture.app, fixture.seed.hotels[1]!.staff.find((s) => s.role === "gm")!.email);
      const otroConfigRes = await fixture.app.request(`/hoteles/${otroHotelId}/voz/config`, { headers: auth(otroGmToken) });
      const otroConfig = (await otroConfigRes.json()) as { toolWebhookSecret: string };

      const res = await llamarTool("crear-tarea-housekeeping", otroConfig.toolWebhookSecret, { roomCode });
      expect(res.status).toBe(401);
    });

    it("hotel sin fila de config todavía (nunca se abrió /voz/config) -> 404", async () => {
      // otroHotelId ya tiene fila porque el test anterior llamó GET /voz/config sobre
      // él -- se usa un uuid random en su lugar para probar el caso real "0 filas".
      const res = await llamarTool("crear-tarea-housekeeping", "cualquier-cosa", { roomCode }, "00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
    });
  });

  describe("gate del hotel (shadow por defecto) sigue aplicando dentro del webhook", () => {
    it("secreto correcto pero enabled=false todavía -> 403", async () => {
      // Se deshabilita de nuevo momentáneamente para probar el 403 explícito.
      await fixture.app.request(`/hoteles/${hotelId}/voz/config`, {
        method: "PATCH",
        headers: auth(ownerToken),
        body: JSON.stringify({ habilitado: false }),
      });
      const config = await getConfig(ownerToken);
      const res = await llamarTool("crear-tarea-housekeeping", config.toolWebhookSecret, { roomCode });
      expect(res.status).toBe(403);

      // Se reactiva para el resto de la suite.
      await fixture.app.request(`/hoteles/${hotelId}/voz/config`, {
        method: "PATCH",
        headers: auth(ownerToken),
        body: JSON.stringify({ habilitado: true }),
      });
    });

    it("gate=shadow (default): la tool NO se ejecuta de verdad, responde modo shadow honesto", async () => {
      const config = await getConfig(ownerToken);
      expect(config.gateRecepcionVirtual).toBe("shadow");

      const res = await llamarTool("crear-tarea-housekeeping", config.toolWebhookSecret, { roomCode, priority: "alta" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { ok: boolean; ejecutado: boolean; modo: string } };
      expect(body.result.ejecutado).toBe(false);
      expect(body.result.modo).toBe("shadow");

      const { rows } = await fixture.engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
      expect(rows).toHaveLength(0);
    });

    it("gate=shadow: crear-ticket-huesped (room service/F&B) tampoco se ejecuta de verdad", async () => {
      const config = await getConfig(ownerToken);
      expect(config.gateRecepcionVirtual).toBe("shadow");

      const res = await llamarTool("crear-ticket-huesped", config.toolWebhookSecret, {
        guestMessage: "El huésped pide una jarra de café y dos vasos a la habitación.",
        roomCode,
        department: "fnb",
        priority: "media",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { ok: boolean; ejecutado: boolean; modo: string } };
      expect(body.result.ejecutado).toBe(false);
      expect(body.result.modo).toBe("shadow");

      const { rows } = await fixture.engine.admin.query(
        "select id from public.guest_ticket where hotel_id = $1 and department = 'fnb';",
        [hotelId],
      );
      expect(rows).toHaveLength(0);
    });

    it("entrada inválida para la tool -> 400 (nunca se intenta ejecutar)", async () => {
      const config = await getConfig(ownerToken);
      const res = await llamarTool("crear-tarea-housekeeping", config.toolWebhookSecret, { roomCode: "" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/entrada inválida/);
    });

    it("crear-ticket-huesped sin department -> 400 (nunca se intenta ejecutar)", async () => {
      const config = await getConfig(ownerToken);
      const res = await llamarTool("crear-ticket-huesped", config.toolWebhookSecret, {
        guestMessage: "El huésped pide algo de room service.",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/entrada inválida/);
    });

    it("gate=shadow: enviar-whatsapp-plantilla también se omite en shadow, ni siquiera crea una solicitud de aprobación", async () => {
      const config = await getConfig(ownerToken);
      expect(config.gateRecepcionVirtual).toBe("shadow");

      const res = await llamarTool("enviar-whatsapp-plantilla", config.toolWebhookSecret, {
        guestPhone: "+5215500001111",
        templateName: "checkin_confirmado",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { ejecutado: boolean; modo: string } };
      expect(body.result.ejecutado).toBe(false);
      expect(body.result.modo).toBe("shadow");

      const { rows } = await fixture.engine.admin.query(
        "select id from public.agent_approval where hotel_id = $1 and tool_name = 'enviar_mensaje_whatsapp_plantilla';",
        [hotelId],
      );
      expect(rows).toHaveLength(0);
    });

    it("gate=propone: crear-tarea-housekeeping y crear-ticket-mantenimiento SÍ ejecutan de verdad", async () => {
      const cfg = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
        method: "PATCH",
        headers: auth(ownerToken),
        body: JSON.stringify({ gate: "propone" }),
      });
      expect(cfg.status).toBe(200);

      const config = await getConfig(ownerToken);
      expect(config.gateRecepcionVirtual).toBe("propone");

      const hk = await llamarTool("crear-tarea-housekeeping", config.toolWebhookSecret, { roomCode, priority: "media" });
      expect(hk.status).toBe(200);
      const hkBody = (await hk.json()) as { result: { ok: boolean; ejecutado: boolean } };
      expect(hkBody.result.ejecutado).toBe(true);
      const { rows: tasks } = await fixture.engine.admin.query("select id from public.housekeeping_task where hotel_id = $1;", [hotelId]);
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      // Room service/F&B: crear-ticket-huesped con department "fnb" -- se manda un
      // `channel: "whatsapp"` a propósito para probar que el webhook lo IGNORA y fuerza
      // "voz" del lado del servidor (ver comentario en vozElevenlabs.ts: este canal
      // nunca confía en un `channel` que mande el modelo).
      const rs = await llamarTool("crear-ticket-huesped", config.toolWebhookSecret, {
        guestMessage: "El huésped pide una jarra de café y dos vasos a la habitación.",
        roomCode,
        department: "fnb",
        priority: "media",
        channel: "whatsapp",
      });
      expect(rs.status).toBe(200);
      const rsBody = (await rs.json()) as { result: { ok: boolean; ejecutado: boolean; datos: { ticketId: string } } };
      expect(rsBody.result.ejecutado).toBe(true);
      const { rows: guestTickets } = await fixture.engine.admin.query<{ id: string; channel: string; department: string }>(
        "select id, channel::text as channel, department::text as department from public.guest_ticket where hotel_id = $1 and department = 'fnb';",
        [hotelId],
      );
      expect(guestTickets).toHaveLength(1);
      expect(guestTickets[0]!.id).toBe(rsBody.result.datos.ticketId);
      expect(guestTickets[0]!.channel).toBe("voz");

      const mant = await llamarTool("crear-ticket-mantenimiento", config.toolWebhookSecret, {
        roomCode,
        title: "Fuga de agua reportada por huésped al llamar",
        description: "El huésped reporta una fuga de agua en el baño durante la llamada telefónica.",
        origin: "agente",
        severity: "alta",
      });
      expect(mant.status).toBe(200);
      const mantBody = (await mant.json()) as { result: { ok: boolean; ejecutado: boolean } };
      expect(mantBody.result.ejecutado).toBe(true);

      const roi = await llamarTool("registrar-evento-roi", config.toolWebhookSecret, {
        tipoEvento: "checkin_asistido_por_voz",
        montoEstimado: 5,
        metodoContrafactual: "Minutos de recepción ahorrados al resolver la incidencia por voz sin transferir a un humano.",
        confianza: 0.5,
      });
      expect(roi.status).toBe(200);
      const roiBody = (await roi.json()) as { result: { ok: boolean; ejecutado: boolean } };
      expect(roiBody.result.ejecutado).toBe(true);
      const { rows: roiRows } = await fixture.engine.admin.query(
        "select id from public.roi_event where hotel_id = $1 and agent_name = 'recepcion_virtual';",
        [hotelId],
      );
      expect(roiRows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("enviar-whatsapp-plantilla: SIEMPRE aprobación humana (nunca auto-aprobado por este canal)", () => {
    it("incluso con la plantilla marcada como transaccional, queda pendiente (T2: sin teléfono de huésped verificado)", async () => {
      const patchTemplates = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
        method: "PATCH",
        headers: auth(gmToken),
        body: JSON.stringify({ plantillasTransaccionales: ["checkin_confirmado"] }),
      });
      expect(patchTemplates.status).toBe(200);

      const config = await getConfig(ownerToken);
      const res = await llamarTool("enviar-whatsapp-plantilla", config.toolWebhookSecret, {
        guestPhone: "+5215500009999",
        templateName: "checkin_confirmado",
        parameters: ["Huésped de voz"],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { ok: boolean; ejecutado: boolean; estado: string; aprobacionId: string } };
      expect(body.result.ejecutado).toBe(false);
      expect(body.result.estado).toBe("pendiente_aprobacion");
      expect(typeof body.result.aprobacionId).toBe("string");

      const { rows: antes } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and template_name = 'checkin_confirmado';",
        [hotelId],
      );
      expect(antes).toHaveLength(0);

      const decidir = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${body.result.aprobacionId}/decidir`, {
        method: "POST",
        headers: auth(ownerToken),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo el envío solicitado por el agente de voz." }),
      });
      expect(decidir.status).toBe(200);

      const { rows: despues } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and template_name = 'checkin_confirmado';",
        [hotelId],
      );
      expect(despues).toHaveLength(1);
    });
  });

  describe("rotar-secreto", () => {
    it("owner rota el secreto y el secreto anterior deja de funcionar", async () => {
      const antes = await getConfig(ownerToken);
      const rot = await fixture.app.request(`/hoteles/${hotelId}/voz/config/rotar-secreto`, {
        method: "POST",
        headers: auth(ownerToken),
      });
      expect(rot.status).toBe(200);
      const { toolWebhookSecret: nuevo } = (await rot.json()) as { toolWebhookSecret: string };
      expect(nuevo).not.toBe(antes.toolWebhookSecret);

      const conViejo = await llamarTool("crear-tarea-housekeeping", antes.toolWebhookSecret, { roomCode });
      expect(conViejo.status).toBe(401);

      const conNuevo = await llamarTool("crear-tarea-housekeeping", nuevo, { roomCode });
      expect(conNuevo.status).toBe(200);
    });
  });
});
