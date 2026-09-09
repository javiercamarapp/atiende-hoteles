// REQ-INT-003 / hallazgo de auditoría corregido: Meta exige responder el `hub.challenge`
// de un GET de verificación antes de activar CUALQUIER webhook
// (https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests)
// -- este endpoint no existía. Fail-closed: sin `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
// configurado, o con un `hub.verify_token` que no coincide, SIEMPRE se rechaza (nunca se
// activa un webhook adivinando el token).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, type ApiFixture } from "../../support/api-fixture.ts";

describe("GET /hoteles/:hotelId/mensajeria/webhook -- verificación de suscripción de Meta", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  const originalToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  beforeAll(async () => {
    fixture = await createApiFixture();
    hotelId = fixture.seed.hotels[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = originalToken;
  });

  it("con el verify_token correcto, responde el hub.challenge tal cual (200, texto plano)", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "token-de-verificacion-real";
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/mensajeria/webhook?hub.mode=subscribe&hub.verify_token=token-de-verificacion-real&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("con un verify_token incorrecto, se rechaza (nunca se activa el webhook)", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "token-de-verificacion-real";
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/mensajeria/webhook?hub.mode=subscribe&hub.verify_token=token-adivinado&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(403);
  });

  it("sin WHATSAPP_WEBHOOK_VERIFY_TOKEN configurado, se rechaza SIEMPRE (fail-closed)", async () => {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/mensajeria/webhook?hub.mode=subscribe&hub.verify_token=cualquier-cosa&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(403);
  });

  it("con hub.mode distinto de 'subscribe' se rechaza aunque el token coincida", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "token-de-verificacion-real";
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/mensajeria/webhook?hub.mode=unsubscribe&hub.verify_token=token-de-verificacion-real&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(403);
  });

  it("esta ruta GET sigue siendo pública -- no exige Bearer de staff", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "token-de-verificacion-real";
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/mensajeria/webhook?hub.mode=subscribe&hub.verify_token=token-de-verificacion-real&hub.challenge=42`,
    );
    expect(res.status).toBe(200); // sin header authorization y no es 401.
  });
});
