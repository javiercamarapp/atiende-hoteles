// Patrón Likida/atiende.ai #8: "cancelar mi reserva"/"queja de pago"/derechos ARCO por
// WhatsApp deben redirigirse a su respectivo flujo estructurado ANTES de caer en la
// clasificación genérica de ticket -- MISMO criterio ya verificado en
// tests/integration/api/mensajeria.spec.ts para captura de PAN (`pago_seguro_enlace`) y
// en mensajeria-clasificacion-tickets.spec.ts para check-in por chat libre
// (`checkin_enlace_estructurado`). Estos 3 intents eran la brecha real: sin guarda
// alguna, caían en el mismo flujo genérico que cualquier otro mensaje.
//
// Sin Meta real: se firma cada payload con `FakeWhatsappAdapter.signWebhookFixture()`
// contra el `webhook_secret` real del hotel, nunca se llama a la API de Meta.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("Patrón Likida/atiende.ai #8: fast-paths deterministas de cancelación/queja de pago/ARCO", () => {
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

  async function plantillaEnviada(templateName: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and direction = 'saliente' and template_name = $2;",
      [hotelId, templateName],
    );
    return rows.length;
  }

  async function ticketsDelHotel(guestMessage: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query(
      "select id from public.guest_ticket where hotel_id = $1 and guest_message = $2;",
      [hotelId, guestMessage],
    );
    return rows.length;
  }

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);

    // `hotel_messaging_config` perezoso, ANTES de pegarle al webhook público -- mismo
    // orden que mensajeria.spec.ts/mensajeria-clasificacion-tickets.spec.ts.
    const cfg = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cfg.status).toBe(200);

    // Gate en "propone" (no "shadow"): así la ausencia de ticket en las pruebas de abajo
    // demuestra de verdad que el fast-path lo evitó, no que el gate ya lo bloqueaba.
    const gateRes = await fixture.app.request(`/hoteles/${hotelId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ gate: "propone" }),
    });
    expect(gateRes.status).toBe(200);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it('"quiero cancelar mi reserva" dispara la plantilla cancelacion_enlace_estructurado y NO crea un guest_ticket genérico', async () => {
    const texto = "Hola, quiero cancelar mi reserva por favor";
    const res = await enviarWebhook("evt-fastpath-cancel-1", "+5215500003001", texto);
    expect(res.status).toBe(200);

    expect(await plantillaEnviada("cancelacion_enlace_estructurado")).toBeGreaterThanOrEqual(1);
    expect(await ticketsDelHotel(texto)).toBe(0);
  });

  it('"no reconozco este cargo en mi tarjeta" dispara queja_pago_enlace_soporte y NO crea un guest_ticket genérico', async () => {
    const texto = "No reconozco este cargo en mi tarjeta, ayuda por favor";
    const res = await enviarWebhook("evt-fastpath-queja-1", "+5215500003002", texto);
    expect(res.status).toBe(200);

    expect(await plantillaEnviada("queja_pago_enlace_soporte")).toBeGreaterThanOrEqual(1);
    expect(await ticketsDelHotel(texto)).toBe(0);
  });

  it('"quiero borrar mis datos personales" dispara arco_enlace_estructurado y NO crea un guest_ticket genérico', async () => {
    const texto = "Quiero borrar mis datos personales del hotel";
    const res = await enviarWebhook("evt-fastpath-arco-1", "+5215500003003", texto);
    expect(res.status).toBe(200);

    expect(await plantillaEnviada("arco_enlace_estructurado")).toBeGreaterThanOrEqual(1);
    expect(await ticketsDelHotel(texto)).toBe(0);
  });

  it("un mensaje normal que no calza ningún fast-path SIGUE creando su guest_ticket como antes (sin regresión)", async () => {
    const texto = "necesito toallas extra";
    const res = await enviarWebhook("evt-fastpath-control-1", "+5215500003004", texto);
    expect(res.status).toBe(200);

    // No se compara plantillaEnviada(...) contra 0 aquí: esas cuentas son a nivel de
    // hotel completo (no por mensaje), y las 3 pruebas anteriores de este mismo
    // `describe` ya enviaron cada plantilla una vez -- lo que importa demostrar es que
    // ESTE mensaje control sí creó su ticket (comportamiento normal preservado).
    expect(await ticketsDelHotel(texto)).toBe(1);
  });
});
