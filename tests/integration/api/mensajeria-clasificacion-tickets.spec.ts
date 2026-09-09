// REQ-HUE-014 · WhatsApp entrante -> `guest_ticket` clasificado automáticamente.
// El webhook real (`POST /hoteles/:hotelId/mensajeria/webhook`, apps/api/src/routes/
// mensajeria.ts) es el único punto real de este repo que procesa un mensaje entrante de
// WhatsApp -- antes de este cambio, un texto libre que no calzaba ninguno de los
// patrones fijos (disclosure/"¿eres humano?"/tarjeta/check-in) solo se guardaba, sin
// ninguna acción de negocio. Esta prueba verifica que ahora se clasifica con
// `classifyGuestMessage` (domain-hotel) y se crea un `guest_ticket` real con
// `crear_ticket_huesped` (agent-core) -- la MISMA función y la MISMA tool que ya usan
// `routes/tickets.ts` (QR/staff) y `routes/agentes.ts` (menor no acompañado), nunca una
// reimplementación -- y que respeta el gate `recepcion_virtual` (agent_config,
// shadow/propone/autopilot) exactamente como `routes/vozElevenlabs.ts` lo hace para el
// canal de voz del mismo agente: en shadow (default, BP-016) NINGÚN ticket se crea desde
// este canal; en propone/autopilot sí, porque `crear_ticket_huesped` tiene
// `needsApproval: false` (registrar una petición no mueve dinero ni sale del sistema).
//
// Sin Meta real: se firma cada payload con `FakeWhatsappAdapter.signWebhookFixture()`
// contra el `webhook_secret` real del hotel, exactamente como
// tests/integration/api/mensajeria.spec.ts -- nunca se llama a la API de Meta.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface GuestTicketRow {
  id: string;
  department: string;
  priority: string;
  channel: string;
  guest_message: string;
  room_id: string | null;
}

describe("REQ-HUE-014: WhatsApp entrante clasifica el mensaje libre y crea el guest_ticket correspondiente", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let hotelId: string;

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

  async function ticketsDelHotel(guestMessage: string): Promise<GuestTicketRow[]> {
    const { rows } = await fixture.engine.admin.query<GuestTicketRow>(
      `select id, department::text as department, priority::text as priority, channel::text as channel,
              guest_message, room_id
       from public.guest_ticket where hotel_id = $1 and guest_message = $2;`,
      [hotelId, guestMessage],
    );
    return rows;
  }

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);

    // Crea `hotel_messaging_config` (perezoso, ver `ensureMessagingConfig`) ANTES de
    // pegarle al webhook público -- mismo orden que mensajeria.spec.ts.
    const cfg = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cfg.status).toBe(200);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("gate=shadow (default, BP-016): el mensaje se guarda pero NO se crea ningún ticket todavía", async () => {
    const res = await enviarWebhook("evt-clasif-shadow-1", "+5215500002001", "necesito toallas");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { estado: string }).estado).toBe("procesado");

    const { rows: mensajes } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and body = 'necesito toallas';",
      [hotelId],
    );
    expect(mensajes).toHaveLength(1); // el mensaje SÍ se guardó (comportamiento ya existente)

    expect(await ticketsDelHotel("necesito toallas")).toHaveLength(0); // pero ningún ticket en shadow
  });

  it("cambia el gate de recepcion_virtual a propone", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ gate: "propone" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { gate: string }).gate).toBe("propone");
  });

  it('gate=propone: "necesito toallas" crea un guest_ticket de housekeeping, prioridad media, canal whatsapp, sin habitación (WhatsApp no vincula teléfono->habitación)', async () => {
    const res = await enviarWebhook("evt-clasif-toallas-1", "+5215500002002", "necesito toallas");
    expect(res.status).toBe(200);

    const tickets = await ticketsDelHotel("necesito toallas");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.department).toBe("housekeeping");
    expect(tickets[0]!.priority).toBe("media");
    expect(tickets[0]!.channel).toBe("whatsapp");
    expect(tickets[0]!.room_id).toBeNull();
  });

  it('gate=propone: "quiero hielo" crea un guest_ticket (departamento por defecto de classifyGuestMessage cuando ninguna palabra clave calza)', async () => {
    const res = await enviarWebhook("evt-clasif-hielo-1", "+5215500002003", "quiero hielo");
    expect(res.status).toBe(200);

    const tickets = await ticketsDelHotel("quiero hielo");
    expect(tickets).toHaveLength(1);
    // "hielo" no está en ninguna lista de palabras clave de DEPARTMENT_KEYWORDS
    // (packages/domain-hotel/src/tickets/slaPolicy.ts) -- `classifyGuestMessage` cae en
    // su default documentado ("frontdesk"/"media"), y esta prueba fija ese
    // comportamiento real en vez de asumir uno sin verificarlo contra la implementación.
    expect(tickets[0]!.department).toBe("frontdesk");
    expect(tickets[0]!.priority).toBe("media");
    expect(tickets[0]!.channel).toBe("whatsapp");
  });

  it('gate=propone: "room service" crea un guest_ticket de fnb, prioridad media', async () => {
    const res = await enviarWebhook("evt-clasif-roomservice-1", "+5215500002004", "room service");
    expect(res.status).toBe(200);

    const tickets = await ticketsDelHotel("room service");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.department).toBe("fnb");
    expect(tickets[0]!.priority).toBe("media");
    expect(tickets[0]!.channel).toBe("whatsapp");
  });

  it('un mensaje YA atendido por un patrón fijo ("¿eres humano?") NO crea un ticket adicional', async () => {
    const res = await enviarWebhook("evt-clasif-eshumano-1", "+5215500002005", "oye, ¿eres humano o un robot?");
    expect(res.status).toBe(200);

    // La respuesta fija de "es humano" sigue funcionando (comportamiento ya existente).
    const { rows: respuesta } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and template_name = 'respuesta_es_humano';",
      [hotelId],
    );
    expect(respuesta.length).toBeGreaterThanOrEqual(1);

    expect(await ticketsDelHotel("oye, ¿eres humano o un robot?")).toHaveLength(0);
  });

  it("un mensaje vacío (evento sin texto) no intenta clasificar ni crear ticket", async () => {
    const secret = await webhookSecret();
    const payload = {
      event_id: "evt-clasif-sintexto-1",
      type: "message.received",
      from: "+5215500002006",
      occurred_at: new Date().toISOString(),
    };
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, secret);
    const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(200);

    const { rows: tickets } = await fixture.engine.admin.query(
      "select id from public.guest_ticket where hotel_id = $1 and channel::text = 'whatsapp' and guest_message = '(mensaje sin texto)';",
      [hotelId],
    );
    expect(tickets).toHaveLength(0);
  });
});
