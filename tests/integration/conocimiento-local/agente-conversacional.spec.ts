// REQ-HUE-026 (H08-024, docs/ACEPTACION.md): "el panel de conocimiento local editable
// por el gerente ... reflejado en las respuestas del agente conversacional en <30 s
// (medido desde el guardado hasta la disponibilidad en el contexto del agente)."
// `tests/integration/conocimiento-local/latencia.spec.ts` ya prueba la FUENTE de datos
// (CRUD sin caché); esta prueba cierra la CONEXIÓN que faltaba (admitida antes en el
// comentario de cabecera de `conocimientoLocal.ts`): que el webhook real de WhatsApp
// (`POST /hoteles/:hotelId/mensajeria/webhook`, único punto real de este repo que
// procesa un mensaje entrante de huésped) consulte esa fuente y responda con el
// contenido VIGENTE -- end-to-end, contra Postgres real (ADR-003), sin llamar nunca a
// Meta (`FakeWhatsappAdapter`, ADR-007, mismo patrón que
// tests/integration/api/mensajeria-clasificacion-tickets.spec.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface MessageRow {
  body: string;
  template_name: string | null;
}

describe("REQ-HUE-026: el agente conversacional refleja el conocimiento local vigente al responder por WhatsApp", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let hotelId: string;

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function webhookSecret(): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
      "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    return rows[0]!.webhook_secret;
  }

  async function enviarWebhook(eventId: string, from: string, text: string): Promise<Response> {
    const secret = await webhookSecret();
    const payload = { event_id: eventId, type: "message.received", from, text, occurred_at: new Date().toISOString() };
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, secret);
    return fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
  }

  async function mensajesSalientesDe(conversationGuestPhone: string): Promise<MessageRow[]> {
    const { rows } = await fixture.engine.admin.query<MessageRow>(
      `select m.body, m.template_name from public.message m
       join public.conversation c on c.id = m.conversation_id
       where c.hotel_id = $1 and c.guest_phone = $2 and m.direction = 'saliente'
       order by m.created_at asc;`,
      [hotelId, conversationGuestPhone],
    );
    return rows;
  }

  async function crearEntradaConocimiento(categoria: string, titulo: string, contenido: string): Promise<{ id: string }> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ categoria, titulo, contenido }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);

    // `hotel_messaging_config` perezoso (ver `ensureMessagingConfig`) ANTES de pegarle
    // al webhook público -- mismo orden que mensajeria.spec.ts.
    const cfg = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, { method: "PATCH", headers: auth(ownerToken), body: "{}" });
    expect(cfg.status).toBe(200);

    // El gate de `recepcion_virtual` respeta el mismo "shadow por defecto" que
    // REQ-HUE-014 -- se activa aquí para poder probar la respuesta REAL del agente
    // (ver también el caso "shadow" explícito más abajo).
    const gate = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "propone" }),
    });
    expect(gate.status).toBe(200);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("el gerente crea una entrada de sargazo y el agente la usa TEXTUALMENTE al responder", async () => {
    const marcador = `Sargazo alto en playa norte, evitar nado ${Date.now()}`;
    await crearEntradaConocimiento("sargazo", "Alerta de sargazo", marcador);

    const res = await enviarWebhook("evt-conoc-sargazo-1", "+5215500003001", "¿hay sargazo en la playa hoy?");
    expect(res.status).toBe(200);

    const salientes = await mensajesSalientesDe("+5215500003001");
    const respuesta = salientes.find((m) => m.body.includes(marcador));
    expect(respuesta).toBeDefined();
    // Respuesta libre (`sendTextMessage`), no una plantilla pre-aprobada.
    expect(respuesta!.template_name).toBeNull();
  });

  it('el gerente ACTUALIZA la entrada y la SIGUIENTE pregunta del huésped refleja el contenido nuevo (<30 s, sin caché)', async () => {
    const original = await crearEntradaConocimiento("ferry", "Horario de ferry", "Salidas cada hora, 8am-6pm");

    const inicio = Date.now();
    const nuevoContenido = `Ferry cancelado por mal tiempo hasta nuevo aviso ${Date.now()}`;
    const patch = await fixture.app.request(`/hoteles/${hotelId}/conocimiento-local/${original.id}`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ contenido: nuevoContenido }),
    });
    expect(patch.status).toBe(200);

    const res = await enviarWebhook("evt-conoc-ferry-1", "+5215500003002", "¿a qué hora sale el ferry?");
    const latenciaMs = Date.now() - inicio;
    expect(res.status).toBe(200);
    expect(latenciaMs).toBeLessThan(30_000); // criterio literal de REQ-HUE-026

    const salientes = await mensajesSalientesDe("+5215500003002");
    const respuesta = salientes.find((m) => m.body.includes(nuevoContenido));
    expect(respuesta).toBeDefined();
    // El contenido VIEJO ya no debe aparecer solo -- la respuesta refleja la fila actual.
    expect(salientes.some((m) => m.body.includes("Salidas cada hora, 8am-6pm"))).toBe(false);
  });

  it("una categoría detectada SIN ninguna entrada configurada no inventa respuesta: el mensaje cae a un guest_ticket real", async () => {
    const res = await enviarWebhook("evt-conoc-eventos-vacio-1", "+5215500003003", "¿qué eventos hay esta semana en el hotel?");
    expect(res.status).toBe(200);

    // `+5215500003003` no había escrito antes en este hotel -- el ÚNICO saliente
    // esperado es el disclosure de primer turno (REQ-HUE-006, `template_name` fijo),
    // nunca una respuesta LIBRE (`template_name` null) de conocimiento local inventada.
    const salientes = await mensajesSalientesDe("+5215500003003");
    expect(salientes.filter((m) => m.template_name === null)).toHaveLength(0);

    const { rows: tickets } = await fixture.engine.admin.query(
      "select id from public.guest_ticket where hotel_id = $1 and guest_message = $2;",
      [hotelId, "¿qué eventos hay esta semana en el hotel?"],
    );
    expect(tickets).toHaveLength(1); // frontdesk sí la atiende
  });

  it('caso negativo CRÍTICO: "el clima no funciona" (aire acondicionado) NO se responde como pregunta de clima -- crea un guest_ticket de mantenimiento', async () => {
    const res = await enviarWebhook("evt-conoc-clima-ac-1", "+5215500003004", "el clima de mi cuarto no funciona, hace mucho calor");
    expect(res.status).toBe(200);

    // Mismo criterio que el caso anterior: el único saliente posible es el disclosure de
    // primer turno; ninguna respuesta LIBRE de "conocimiento local" debe existir.
    const salientes = await mensajesSalientesDe("+5215500003004");
    expect(salientes.filter((m) => m.template_name === null)).toHaveLength(0);

    const { rows: tickets } = await fixture.engine.admin.query<{ department: string }>(
      "select department::text as department from public.guest_ticket where hotel_id = $1 and guest_message = $2;",
      [hotelId, "el clima de mi cuarto no funciona, hace mucho calor"],
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.department).toBe("maintenance");
  });

  it("gate=shadow: ninguna respuesta de conocimiento local se envía (el agente no actúa todavía)", async () => {
    await crearEntradaConocimiento("sargazo", "Alerta de sargazo (shadow)", "Contenido que no debe salir en shadow");

    const gate = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "shadow" }),
    });
    expect(gate.status).toBe(200);

    const res = await enviarWebhook("evt-conoc-shadow-1", "+5215500003005", "¿hay sargazo en la playa?");
    expect(res.status).toBe(200);

    // El disclosure de primer turno NO está gateado (GOB-034 es incondicional) y sigue
    // enviándose incluso en shadow -- lo que este caso prueba es que NINGUNA respuesta
    // LIBRE de conocimiento local se envía mientras el gate del agente esté en shadow.
    const salientes = await mensajesSalientesDe("+5215500003005");
    expect(salientes.filter((m) => m.template_name === null)).toHaveLength(0);

    // Restaura el gate para no afectar el orden de otras pruebas de este archivo si se re-ejecutan.
    await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ gate: "propone" }),
    });
  });
});
