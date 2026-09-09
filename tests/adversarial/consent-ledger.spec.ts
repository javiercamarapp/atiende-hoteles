// REQ-HUE-024: "El sistema debe registrar y consultar un consent ledger multi-país
// antes de cualquier comunicación outbound de marketing/upsell."
//
// El bloqueo de envío sin opt-in vigente ya está probado en
// tests/adversarial/opt-in-marketing.spec.ts (REQ-HUE-021/REQ-SEG-007) -- ese archivo
// registra el opt-in de prueba con un INSERT directo vía el cliente admin porque,
// hasta este REQ, NINGUNA ruta real de `apps/api` permitía registrar un consentimiento
// de marketing (confirmado con `grep -rn "record_consent(" apps/`: la única ruta que lo
// invoca es `checkinOnline.ts`, y solo para `tratamiento_datos`).
//
// Este archivo cierra ese hueco de punta a punta, usando SOLO rutas HTTP reales (nunca
// el cliente admin para registrar el consentimiento):
//  1) Sin ningún registro: un envío de marketing es bloqueado (mismo gate de
//     REQ-HUE-021, sin tocar).
//  2) El staff registra el consentimiento de marketing por la ruta NUEVA
//     (`POST /hoteles/:hotelId/huespedes/:guestId/consentimiento`) -- la jurisdicción
//     (MX, derivada del teléfono E.164 del huésped) queda anotada en la respuesta.
//  3) El envío de marketing, que antes era bloqueado, ahora procede (misma ruta de
//     envío, sin ningún cambio en el gate: el registro por sí solo lo desbloquea).
//  4) El ledger (`GET /hoteles/:hotelId/consentimiento/ledger`) puede CONSULTARSE por
//     jurisdicción -- lo que H09-029 pide poder auditar "multi-país" -- y refleja el
//     otorgamiento real.
//  5) Un opt-out posterior por la MISMA ruta (granted=false) vuelve a bloquear el
//     envío -- el ledger es la única fuente de verdad, sin caché obsoleto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: REQ-HUE-024 -- consent ledger multi-país antes de outbound de marketing", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;

  const TEMPLATE_MARKETING = "promo_temporada_alta_ledger";
  const TEXTO_MARKETING_CON_BAJA =
    "¡Tarifa especial solo esta semana! Responde BAJA si no quieres volver a recibir promociones.";
  const PHONE_MX = "+528111239001";

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);

    const config = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        plantillasTransaccionales: [],
        plantillasMarketing: [TEMPLATE_MARKETING],
        textosPlantillasMarketing: { [TEMPLATE_MARKETING]: TEXTO_MARKETING_CON_BAJA },
      }),
    });
    expect(config.status).toBe(200);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const auth = () => ({ authorization: `Bearer ${gmToken}`, "content-type": "application/json" });

  async function crearGuest(phone: string, fullName: string): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name, phone) values ($1, $2, $3, $4) returning id;",
      [fixture.seed.orgId, hotelId, fullName, phone],
    );
    return rows[0]!.id;
  }

  async function enviar(guestPhone: string): Promise<Response> {
    return fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ guestPhone, templateName: TEMPLATE_MARKETING, parameters: [] }),
    });
  }

  async function registrarConsentimientoViaRuta(guestId: string, granted: boolean): Promise<Response> {
    return fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/consentimiento`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        consentKind: "marketing",
        channel: "whatsapp",
        granted,
        avisoVersion: `aviso-marketing-v1-${Date.now()}`,
      }),
    });
  }

  it("un mensaje de marketing SIN ningún consentimiento registrado es bloqueado (mismo gate de REQ-HUE-021, sin tocar)", async () => {
    const guestId = await crearGuest(PHONE_MX, "Huésped Ledger MX");
    const res = await enviar(PHONE_MX);
    expect(res.status).toBe(409);

    // Confirma también que el ledger, consultado, está vacío para este huésped --
    // "no hay registro" y "hay un registro pero no se consultó" son estados distintos,
    // y este test verifica el primero.
    const ledger = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    const ledgerBody = (await ledger.json()) as { ledger: Array<{ guestId: string }> };
    expect(ledgerBody.ledger.some((e) => e.guestId === guestId)).toBe(false);
  });

  it("el staff registra el consentimiento por la ruta REAL (no el cliente admin) y queda anotado con jurisdicción MX", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.guest where hotel_id = $1 and phone = $2;",
      [hotelId, PHONE_MX],
    );
    const guestId = rows[0]!.id;

    const registro = await registrarConsentimientoViaRuta(guestId, true);
    expect(registro.status).toBe(201);
    const registroBody = (await registro.json()) as { jurisdiccion: string; consentKind: string; granted: boolean };
    expect(registroBody.jurisdiccion).toBe("MX");
    expect(registroBody.consentKind).toBe("marketing");
    expect(registroBody.granted).toBe(true);
  });

  it("el envío de marketing, antes bloqueado, ahora procede (pasa a aprobación humana y se ejecuta al aprobarse)", async () => {
    const envio = await enviar(PHONE_MX);
    expect(envio.status).toBe(202);
    const { aprobacionId } = (await envio.json()) as { aprobacionId: string };

    const decidir = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo el envío." }),
    });
    expect(decidir.status).toBe(200);
    const decidido = (await decidir.json()) as { ejecutado: boolean };
    expect(decidido.ejecutado).toBe(true);

    const { rows } = await fixture.engine.admin.query(
      `select m.id from public.message m
       join public.conversation c on c.id = m.conversation_id
       where m.hotel_id = $1 and m.template_name = $2 and c.guest_phone = $3 and m.direction = 'saliente';`,
      [hotelId, TEMPLATE_MARKETING, PHONE_MX],
    );
    expect(rows).toHaveLength(1);
  });

  it("el ledger, consultado por jurisdicción, refleja el consentimiento otorgado (lo que REQ-HUE-024 pide poder auditar)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger?jurisdiccion=MX&tipo=marketing`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ledger: Array<{ jurisdiccion: string; otorgado: boolean }>;
      resumen: Array<{ jurisdiction: string; consentKind: string; granted: number; revoked: number }>;
    };
    expect(body.ledger.length).toBeGreaterThan(0);
    expect(body.ledger.every((e) => e.jurisdiccion === "MX")).toBe(true);
    expect(body.resumen.some((b) => b.jurisdiction === "MX" && b.consentKind === "marketing" && b.granted >= 1)).toBe(
      true,
    );
  });

  it("un opt-out posterior por la MISMA ruta vuelve a bloquear el envío -- el ledger es la única fuente de verdad", async () => {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.guest where hotel_id = $1 and phone = $2;",
      [hotelId, PHONE_MX],
    );
    const guestId = rows[0]!.id;

    const optOut = await registrarConsentimientoViaRuta(guestId, false);
    expect(optOut.status).toBe(201);

    const envio = await enviar(PHONE_MX);
    expect(envio.status).toBe(409);
  });
});
