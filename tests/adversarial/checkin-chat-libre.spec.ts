// REQ-RES-016: "El check-in online debe capturarse mediante un WhatsApp Flow cifrado
// o un formulario web de un solo uso — nunca por chat libre." Dos garantías probadas:
//   1. ESTRUCTURAL: ningún código de este repo registra un documento de identidad a
//      partir de un mensaje de WhatsApp entrante -- la ÚNICA vía real es
//      complete_checkin_public()/register_identity_document() (0051/0054), ambas
//      alcanzables solo por /checkin-publico/:token o /hoteles/:id/reservas/:id/identidad,
//      nunca por el webhook de mensajería entrante.
//   2. UX: un mensaje de chat libre que PARECE un intento de enviar datos de check-in
//      (frase + MRZ/RFC) dispara un mensaje de redirección al flujo estructurado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: check-in por chat libre es rechazado y redirigido (REQ-RES-016)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function webhookSecret(): Promise<string> {
    // Fuerza la creación perezosa de hotel_messaging_config enviando primero una
    // plantilla transaccional (mismo camino que tests/integration/api/mensajeria.spec.ts).
    await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ plantillasTransaccionales: ["checkin_confirmado"] }),
    });
    const { rows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
      "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    return rows[0]!.webhook_secret;
  }

  async function enviarMensajeEntrante(eventId: string, from: string, text: string) {
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      { event_id: eventId, type: "message.received", from, text, occurred_at: new Date().toISOString() },
      secret,
    );
    return fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
  }

  it("un mensaje que parece traer datos de check-in dispara una redirección al flujo estructurado", async () => {
    const from = "+5215500002001";
    const res = await enviarMensajeEntrante(
      "evt-chat-checkin-1",
      from,
      "Hola, quiero hacer mi check-in ahora, mi RFC es GALA900101ABC y mi pasaporte es G1234567",
    );
    expect(res.status).toBe(200);

    const { rows: conv } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.conversation where hotel_id = $1 and guest_phone = $2;",
      [hotelId, from],
    );
    const { rows: mensajes } = await fixture.engine.admin.query<{ direction: string; template_name: string | null }>(
      "select direction, template_name from public.message where conversation_id = $1 order by created_at asc;",
      [conv[0]!.id],
    );

    expect(mensajes.some((m) => m.direction === "entrante")).toBe(true);
    const redireccion = mensajes.find((m) => m.direction === "saliente" && m.template_name === "checkin_enlace_estructurado");
    expect(redireccion).toBeTruthy();
  });

  it("un mensaje normal (sin datos sensibles) NO dispara ninguna redirección", async () => {
    const from = "+5215500002002";
    const res = await enviarMensajeEntrante("evt-chat-normal-1", from, "¿A qué hora es el check-out?");
    expect(res.status).toBe(200);

    const { rows: conv } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.conversation where hotel_id = $1 and guest_phone = $2;",
      [hotelId, from],
    );
    const { rows: mensajes } = await fixture.engine.admin.query<{ direction: string; template_name: string | null }>(
      "select direction, template_name from public.message where conversation_id = $1;",
      [conv[0]!.id],
    );
    // Alcance de ESTE REQ (RES-016): ningún mensaje de redirección de check-in. El
    // único saliente esperado aquí es el disclosure de IA de REQ-HUE-006 (primer turno
    // de esta conversación nueva) -- no relacionado con check-in, cubierto y contado
    // aparte por tests/adversarial/disclosure-ia.spec.ts.
    expect(mensajes.some((m) => m.direction === "saliente" && m.template_name === "checkin_enlace_estructurado")).toBe(false);
    expect(mensajes.filter((m) => m.direction === "saliente")).toHaveLength(1);
    expect(mensajes.find((m) => m.direction === "saliente")!.template_name).toBe("disclosure_ia");
  });

  it("estructural: NINGÚN mensaje de chat libre, sin importar su contenido, crea una fila en identity_vault", async () => {
    const antes = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_vault where hotel_id = $1;",
      [hotelId],
    );

    await enviarMensajeEntrante(
      "evt-chat-checkin-2",
      "+5215500002003",
      "check-in: P<MEXHERNANDEZ<<LUIS<<<<<<<<<<<<<<<<<<<<<<<<<<<< mi RFC HETL850505XYZ",
    );

    const despues = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_vault where hotel_id = $1;",
      [hotelId],
    );
    expect(despues.rows[0]!.count).toBe(antes.rows[0]!.count); // sin cambio: 0 documentos registrados desde chat.
  });
});
