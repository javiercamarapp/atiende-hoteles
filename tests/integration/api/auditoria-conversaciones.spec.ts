// REQ-HUE-007 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe auditar
// semanalmente una muestra de conversaciones/llamadas (p. ej. 30) para detectar
// errores del bot [...]." Contra embedded-postgres real (ADR-003): genera conversaciones
// REALES vía el mismo webhook de WhatsApp simulado que usa el canal real
// (FakeWhatsappAdapter, mismo patrón que tests/adversarial/disclosure-ia.spec.ts), y
// ejercita las 3 rutas nuevas (`apps/api/src/routes/auditoriaConversaciones.ts`) de
// punta a punta: generar la muestra semanal (idempotente), consultarla, y registrar el
// veredicto de revisión de un ítem.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface SampleBody {
  id: string;
  conversationId: string;
  semanaDe: string;
  revisadoEn: string | null;
  categoria: string | null;
  notas: string | null;
  conversacion: { canal: string; telefonoHuesped: string | null };
}

describe("REQ-HUE-007: auditoría semanal de conversaciones", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function webhookSecret(): Promise<string> {
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
    const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(200);
  }

  async function conversationIdDe(guestPhone: string): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.conversation where hotel_id = $1 and guest_phone = $2;",
      [hotelId, guestPhone],
    );
    return rows[0]!.id;
  }

  let idDentroVentana: string[] = [];
  let idFueraVentana = "";

  it("crea 3 conversaciones recientes + 1 vieja (fuera de ventana), vía el canal real simulado", async () => {
    await enviarMensajeEntrante("evt-audit-1", "+5215500009001", "Hola, ¿tienen disponibilidad para mañana?");
    await enviarMensajeEntrante("evt-audit-2", "+5215500009002", "¿Cuál es el precio de la habitación doble?");
    await enviarMensajeEntrante("evt-audit-3", "+5215500009003", "¿A qué hora es el checkout?");
    await enviarMensajeEntrante("evt-audit-old", "+5215500009999", "Mensaje de hace dos semanas.");

    idDentroVentana = [
      await conversationIdDe("+5215500009001"),
      await conversationIdDe("+5215500009002"),
      await conversationIdDe("+5215500009003"),
    ];
    idFueraVentana = await conversationIdDe("+5215500009999");

    // Retrasa artificialmente la conversación "vieja" 2 semanas -- misma técnica que
    // el resto de este repo usa para simular tiempo transcurrido sin esperar de verdad
    // (ver tests/integration/tickets/sla-escalado.spec.ts).
    await fixture.engine.admin.query(
      "update public.conversation set last_message_at = now() - interval '14 days' where id = $1;",
      [idFueraVentana],
    );
  });

  let sampleIds: string[] = [];

  it("POST genera la muestra semanal: incluye las 3 recientes, excluye la de hace 2 semanas", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { semanaDe: string; muestra: SampleBody[]; yaExistia: boolean };
    expect(body.yaExistia).toBe(false);

    const conversationIds = body.muestra.map((m) => m.conversationId);
    for (const id of idDentroVentana) expect(conversationIds).toContain(id);
    expect(conversationIds).not.toContain(idFueraVentana);
    sampleIds = body.muestra.map((m) => m.id);
  });

  it("POST otra vez la MISMA semana es idempotente: no vuelve a sortear ni duplica filas", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200); // ya existía: no crea nada, se devuelve tal cual (200, no 201).
    const body = (await res.json()) as { muestra: SampleBody[]; yaExistia: boolean };
    expect(body.yaExistia).toBe(true);
    expect(body.muestra.map((m) => m.id).sort()).toEqual([...sampleIds].sort());
  });

  it("GET consulta la muestra ya generada sin volver a generarla", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { muestra: SampleBody[] };
    expect(body.muestra.map((m) => m.id).sort()).toEqual([...sampleIds].sort());
    for (const item of body.muestra) {
      expect(item.revisadoEn).toBeNull();
      expect(item.conversacion.canal).toBe("whatsapp");
    }
  });

  it("PATCH exige nota cuando la categoría marca un error real", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones/${sampleIds[0]}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ categoria: "alucinacion" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH registra el veredicto de revisión con nota", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones/${sampleIds[0]}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ categoria: "disponibilidad_o_precio_incorrecto", notas: "cotizó tarifa de temporada baja en temporada alta" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SampleBody;
    expect(body.categoria).toBe("disponibilidad_o_precio_incorrecto");
    expect(body.notas).toBe("cotizó tarifa de temporada baja en temporada alta");
    expect(body.revisadoEn).not.toBeNull();
  });

  it("PATCH con categoría 'ninguno' no exige nota", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones/${sampleIds[1]}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ categoria: "ninguno" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SampleBody;
    expect(body.categoria).toBe("ninguno");
    expect(body.notas).toBeNull();
  });

  it("un rol que no es owner/gm no puede generar ni consultar la muestra (auditoría gerencial)", async () => {
    const postRes = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(403);

    const getRes = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      headers: { authorization: `Bearer ${frontdeskToken}` },
    });
    expect(getRes.status).toBe(403);
  });

  it("una semana sin ninguna conversación candidata genera una muestra vacía, no un error", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/auditoria-conversaciones`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ weekOf: "2020-01-06" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { muestra: SampleBody[] };
    expect(body.muestra).toEqual([]);
  });
});
