// REQ-HUE-006/GOB-034 — "El agente debe emitir el disclosure de IA en los primeros 4
// segundos de una llamada o en el primer mensaje de un hilo de WhatsApp, generado
// desde el `disclosure engine`, y responder de forma fija (no generativa) a
// '¿eres humano?'." Este archivo es el acceptance test que docs/ACEPTACION.md y
// docs/REQUISITOS.md ya declaraban (`tests/adversarial/disclosure-ia.spec.ts`) pero que
// no existía en el repo -- el mecanismo vivía en agent-core (runner.ts `close()` +
// `ToolContext.isFirstTurn`, ya cubierto por tests/unit/agent-core/{context,runner}.spec.ts)
// pero NINGÚN código de apps/api lo invocaba: el único punto real que procesa un
// mensaje entrante de huésped (routes/mensajeria.ts webhook) nunca llamaba al
// disclosure engine ni fijaba "primer turno" -- exactamente el patrón de "mecanismo
// implementado pero desconectado del flujo real" ya visto en otros REQ de este repo.
//
// Alcance de este archivo: canal WhatsApp (el único con un flujo de mensaje entrante
// real en este repo, vía FakeWhatsappAdapter -- sin llamar nunca a Meta real, ADR-007).
// El canal de voz depende de telefonía/PBX real (Telnyx, ver docs/REQUISITOS.md §5) que
// no existe todavía en este repo -- no se simula aquí.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { WHATSAPP_DISCLOSURE_MESSAGE, RESPUESTA_FIJA_ES_HUMANO, esPreguntaSiEsHumano } from "@atiende-hoteles/agent-core";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

interface MensajeRow {
  direction: string;
  template_name: string | null;
  body: string;
}

describe("adversarial: disclosure de IA en WhatsApp (REQ-HUE-006/GOB-034)", () => {
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
    // Fuerza la creación perezosa de hotel_messaging_config (mismo camino que
    // tests/integration/api/mensajeria.spec.ts / tests/adversarial/checkin-chat-libre.spec.ts).
    await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ plantillasTransaccionales: [] }),
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

  async function mensajesDe(guestPhone: string): Promise<MensajeRow[]> {
    const { rows: conv } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.conversation where hotel_id = $1 and guest_phone = $2;",
      [hotelId, guestPhone],
    );
    const { rows } = await fixture.engine.admin.query<MensajeRow>(
      "select direction, template_name, body from public.message where conversation_id = $1 order by created_at asc;",
      [conv[0]!.id],
    );
    return rows;
  }

  it("el PRIMER mensaje de un hilo nuevo de WhatsApp recibe el disclosure de IA, generado desde el disclosure engine (agent-core)", async () => {
    const from = "+5215500003001";
    const res = await enviarMensajeEntrante("evt-disclosure-1", from, "Hola, ¿tienen alberca?");
    expect(res.status).toBe(200);

    const mensajes = await mensajesDe(from);
    const disclosure = mensajes.find((m) => m.direction === "saliente" && m.template_name === "disclosure_ia");
    expect(disclosure).toBeTruthy();
    // Texto EXACTO tomado del disclosure engine (agent-core), no un string reinventado
    // en apps/api -- verifica que el canal y el núcleo del agente comparten una sola
    // fuente de verdad (mismo principio que runner.ts `close()`).
    expect(disclosure!.body).toBe(WHATSAPP_DISCLOSURE_MESSAGE);
  });

  it("el SEGUNDO mensaje del MISMO hilo NO repite el disclosure (solo el primer turno)", async () => {
    const from = "+5215500003001"; // mismo huésped/conversación del test anterior
    const res = await enviarMensajeEntrante("evt-disclosure-2", from, "¿Y el desayuno a qué hora empieza?");
    expect(res.status).toBe(200);

    const mensajes = await mensajesDe(from);
    const disclosures = mensajes.filter((m) => m.direction === "saliente" && m.template_name === "disclosure_ia");
    expect(disclosures).toHaveLength(1); // sigue siendo 1 (el del primer turno), no 2.
  });

  it("una conversación nueva DISTINTA (otro huésped) sí recibe su propio disclosure de primer turno", async () => {
    const from = "+5215500003002";
    const res = await enviarMensajeEntrante("evt-disclosure-3", from, "Buenas, quería preguntar por tarifas.");
    expect(res.status).toBe(200);

    const mensajes = await mensajesDe(from);
    expect(mensajes.some((m) => m.direction === "saliente" && m.template_name === "disclosure_ia")).toBe(true);
  });

  it('la pregunta "¿eres humano?" responde con texto FIJO idéntico, no generativo', async () => {
    const from = "+5215500003003";
    const res = await enviarMensajeEntrante("evt-disclosure-4", from, "Oye, ¿eres humano o un bot?");
    expect(res.status).toBe(200);

    const mensajes = await mensajesDe(from);
    const respuesta = mensajes.find((m) => m.direction === "saliente" && m.template_name === "respuesta_es_humano");
    expect(respuesta).toBeTruthy();
    expect(respuesta!.body).toBe(RESPUESTA_FIJA_ES_HUMANO);
  });

  it('variantes de "¿eres humano?" en turnos y huéspedes distintos producen SIEMPRE el mismo texto (no generativo)', async () => {
    const casos: Array<[string, string, string]> = [
      ["evt-disclosure-5", "+5215500003004", "hola, ¿ERES HUMANO?"],
      ["evt-disclosure-6", "+5215500003005", "disculpa, ¿hablo con un humano?"],
      ["evt-disclosure-7", "+5215500003006", "¿Es esto un bot?"],
    ];
    for (const [eventId, from, texto] of casos) {
      const res = await enviarMensajeEntrante(eventId, from, texto);
      expect(res.status).toBe(200);
      const mensajes = await mensajesDe(from);
      const respuesta = mensajes.find((m) => m.direction === "saliente" && m.template_name === "respuesta_es_humano");
      expect(respuesta).toBeTruthy();
      expect(respuesta!.body).toBe(RESPUESTA_FIJA_ES_HUMANO);
    }
  });

  it('un mensaje normal que NO pregunta si es humano no dispara la respuesta fija', async () => {
    const from = "+5215500003007";
    const res = await enviarMensajeEntrante("evt-disclosure-8", from, "¿Cuál es el horario de check-out?");
    expect(res.status).toBe(200);

    const mensajes = await mensajesDe(from);
    expect(mensajes.some((m) => m.direction === "saliente" && m.template_name === "respuesta_es_humano")).toBe(false);
  });

  it("esPreguntaSiEsHumano() (unidad, agent-core): detecta variantes y rechaza mensajes no relacionados", () => {
    expect(esPreguntaSiEsHumano("¿Eres humano?")).toBe(true);
    expect(esPreguntaSiEsHumano("eres un robot?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿hablo con una persona?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿Eres tú una IA?")).toBe(true);
    expect(esPreguntaSiEsHumano(null)).toBe(false);
    expect(esPreguntaSiEsHumano(undefined)).toBe(false);
    expect(esPreguntaSiEsHumano("¿A qué hora es el check-out?")).toBe(false);
    expect(esPreguntaSiEsHumano("el diario está en la mesa")).toBe(false); // no falso-positivo por "dia"/"ia" dentro de otra palabra
  });
});
