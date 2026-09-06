// H6b · /mensajeria vía la API real (REQ-HUE-001/002, REQ-HK-002/013/021, H09): plantilla
// transaccional se envía SIN espera humana, plantilla no transaccional queda pendiente en
// /aprobaciones hasta que un gerente decide, y el webhook de entrada verifica HMAC +
// idempotencia por event_id (sin llamar nunca a Meta real, FakeWhatsappAdapter).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: mensajeria (integración real, sin Meta)", () => {
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

  const auth = () => ({ authorization: `Bearer ${gmToken}` });

  it("configura plantillas transaccionales del hotel", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ plantillasTransaccionales: ["checkin_confirmado"] }),
    });
    expect(res.status).toBe(200);
  });

  it("envía una plantilla TRANSACCIONAL sin espera humana (needsApproval=true, auto-aprobada)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ guestPhone: "+5215500000001", templateName: "checkin_confirmado", parameters: ["Ana"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { estado: string; simulated: boolean };
    expect(body.estado).toBe("enviado");
    expect(body.simulated).toBe(true);
  });

  it("una plantilla NO transaccional queda pendiente de aprobación hasta que un gerente decide", async () => {
    const envio = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ guestPhone: "+5215500000002", templateName: "oferta_upsell", parameters: ["Suite"] }),
    });
    expect(envio.status).toBe(202);
    const { aprobacionId } = (await envio.json()) as { aprobacionId: string };

    const antes = await fixture.engine.admin.query("select id from public.message where hotel_id = $1 and template_name = 'oferta_upsell';", [hotelId]);
    expect(antes.rows).toHaveLength(0);

    const decidir = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo enviar la oferta de upsell." }),
    });
    expect(decidir.status).toBe(200);
    const decidido = (await decidir.json()) as { estado: string; ejecutado: boolean };
    expect(decidido.estado).toBe("aprobada");
    expect(decidido.ejecutado).toBe(true);

    const despues = await fixture.engine.admin.query("select id from public.message where hotel_id = $1 and template_name = 'oferta_upsell';", [hotelId]);
    expect(despues.rows).toHaveLength(1);
  });

  it("GET conversaciones y GET hilo de mensajes reflejan lo enviado", async () => {
    const lista = await fixture.app.request(`/hoteles/${hotelId}/mensajeria`, { headers: auth() });
    expect(lista.status).toBe(200);
    const conversaciones = (await lista.json()) as Array<{ id: string; huesped: string }>;
    expect(conversaciones.length).toBeGreaterThanOrEqual(2);

    const hilo = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/${conversaciones[0]!.id}/mensajes`, { headers: auth() });
    expect(hilo.status).toBe(200);
    const mensajes = (await hilo.json()) as Array<{ direccion: string; simulado: boolean }>;
    expect(mensajes.length).toBeGreaterThan(0);
    expect(mensajes.every((m) => m.simulado)).toBe(true);
  });

  describe("webhook de entrada (público, HMAC + idempotencia)", () => {
    it("firma inválida es rechazada (401)", async () => {
      const payload = { event_id: "evt-1", type: "message.received", from: "+5215500000009", text: "hola", occurred_at: new Date().toISOString() };
      const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=firma-invalida" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(401);
    });

    it("firma válida procesa el evento e inserta el mensaje entrante", async () => {
      const { rows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
        "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
        [hotelId],
      );
      const secret = rows[0]!.webhook_secret;
      const payload = { event_id: "evt-2", type: "message.received", from: "+5215500000009", text: "¿Tienen desayuno incluido?", occurred_at: new Date().toISOString() };
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, secret);

      const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { estado: string }).estado).toBe("procesado");

      const { rows: messages } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and body = $2;",
        [hotelId, "¿Tienen desayuno incluido?"],
      );
      expect(messages).toHaveLength(1);
    });

    it("un replay del MISMO event_id es rechazado (no reprocesa ni duplica)", async () => {
      const { rows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
        "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
        [hotelId],
      );
      const secret = rows[0]!.webhook_secret;
      const payload = { event_id: "evt-2", type: "message.received", from: "+5215500000009", text: "¿Tienen desayuno incluido?", occurred_at: new Date().toISOString() };
      const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(payload, secret);

      const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { estado: string }).estado).toBe("duplicado");

      const { rows: messages } = await fixture.engine.admin.query(
        "select id from public.message where hotel_id = $1 and body = $2;",
        [hotelId, "¿Tienen desayuno incluido?"],
      );
      expect(messages).toHaveLength(1); // sigue siendo 1, no se duplicó
    });
  });
});
