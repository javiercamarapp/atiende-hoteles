// REQ-HUE-021/REQ-SEG-007: "Mensaje transaccional (utility) puede enviarse sin opt-in;
// mensaje de marketing es bloqueado si no existe opt-in registrado (fecha/canal/texto)
// previo al envío (verificado con caso sin opt-in → 0 envíos de marketing); todo mensaje
// de marketing incluye opción de baja (verificado con mensaje sin opción de baja →
// rechazado por el linter de plantillas)."
//
// Ejercitado contra la API real (Hono + embedded-postgres) enviando
// `POST /hoteles/:hotelId/mensajeria/mensajes`, nunca llamando la función de dominio
// directo -- así se prueba la MISMA ruta que usa el panel de mensajería real, y la
// infraestructura de opt-in ya existente desde la migración 0068 (`consent`,
// `record_consent()`).
//
// Cubre:
//  (a) TRANSACCIONAL: una plantilla NO marcada como marketing se envía sin ningún
//      opt-in registrado (ni siquiera un huésped existente con ese teléfono).
//  (b) MARKETING SIN OPT-IN: 0 envíos -- ni fila en `message`, ni aprobación quedando
//      "aprobable hacia un envío real" (se rechaza 409 antes de crear la solicitud).
//  (c) MARKETING CON OPT-IN VIGENTE: se registra opt-in real (fecha/canal/texto vía
//      `record_consent`) y el envío procede (pasa por aprobación humana, como
//      cualquier plantilla no transaccional, y al aprobarse SÍ crea el mensaje) -- y el
//      cuerpo del mensaje REALMENTE persistido incluye la opción de baja registrada.
//  (d) DENY-BY-DEFAULT: opt-in con `granted=false` (baja/opt-out explícito) y opt-in de
//      OTRO canal (web, no whatsapp) NUNCA cuentan como opt-in vigente de marketing por
//      WhatsApp -- 0 envíos en ambos casos.
//  (e) DEFENSA EN PROFUNDIDAD: si una solicitud de marketing sin opt-in de todos modos
//      queda pendiente de aprobación (agente que ignoró el chequeo de la ruta) y un
//      gerente la aprueba sin saber que falta el opt-in, `tool.run()` la bloquea igual
//      -- 0 envíos también por esa vía.
//  (f) LINTER DE PLANTILLAS (REQ-SEG-007): `PATCH .../mensajeria/config` rechaza (400)
//      cualquier intento de clasificar una plantilla como marketing cuyo texto no
//      incluya una opción de baja reconocible -- sin importar que traiga opt-in de otras
//      plantillas o texto no vacío -- y la plantilla NUNCA queda clasificada como
//      marketing tras el rechazo (config sin cambios).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresApprovalQueue, SEND_WHATSAPP_TEMPLATE_TOOL_NAME } from "@atiende-hoteles/agent-core";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: REQ-HUE-021/REQ-SEG-007 -- opt-in de marketing antes de enviar", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;

  const TEMPLATE_TRANSACCIONAL = "confirmacion_reserva";
  const TEMPLATE_MARKETING = "promo_temporada_alta";
  const TEXTO_MARKETING_CON_BAJA =
    "¡Descuento de temporada alta solo por hoy! Responde BAJA para dejar de recibir estos mensajes.";

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);

    const config = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        plantillasTransaccionales: [TEMPLATE_TRANSACCIONAL],
        plantillasMarketing: [TEMPLATE_MARKETING],
        textosPlantillasMarketing: { [TEMPLATE_MARKETING]: TEXTO_MARKETING_CON_BAJA },
      }),
    });
    expect(config.status).toBe(200);
    const configBody = (await config.json()) as { textosPlantillasMarketing: Record<string, string> };
    expect(configBody.textosPlantillasMarketing[TEMPLATE_MARKETING]).toBe(TEXTO_MARKETING_CON_BAJA);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const auth = () => ({ authorization: `Bearer ${gmToken}`, "content-type": "application/json" });

  async function enviar(guestPhone: string, templateName: string): Promise<Response> {
    return fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ guestPhone, templateName, parameters: [] }),
    });
  }

  // Filtrado por (hotelId, templateName, phone DEL DESTINATARIO vía `conversation`) --
  // varios casos de este archivo reutilizan el MISMO nombre de plantilla de marketing
  // contra teléfonos distintos, así que contar solo por plantilla contaría envíos de
  // otros casos ya verdes.
  async function countMensajesEnviados(templateName: string, guestPhone: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query(
      `select m.id
       from public.message m
       join public.conversation c on c.id = m.conversation_id
       where m.hotel_id = $1 and m.template_name = $2 and m.direction = 'saliente' and c.guest_phone = $3;`,
      [hotelId, templateName, guestPhone],
    );
    return rows.length;
  }

  async function crearGuest(phone: string, fullName: string): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name, phone) values ($1, $2, $3, $4) returning id;",
      [fixture.seed.orgId, hotelId, fullName, phone],
    );
    return rows[0]!.id;
  }

  async function registrarOptIn(params: { guestId: string; channel: string; granted: boolean }): Promise<void> {
    await fixture.engine.admin.query(
      "select public.record_consent($1, $2, null, $3, $4, 'marketing', $5, $6);",
      [
        fixture.seed.orgId,
        hotelId,
        params.guestId,
        params.channel,
        `Acepto recibir promociones por ${params.channel} (prueba adversarial ${new Date().toISOString()})`,
        params.granted,
      ],
    );
  }

  describe("(a) transaccional: se envía SIN ningún opt-in registrado", () => {
    it("plantilla transaccional a un teléfono sin ningún guest/consent previo se envía de inmediato", async () => {
      const res = await enviar("+5215500009001", TEMPLATE_TRANSACCIONAL);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { estado: string };
      expect(body.estado).toBe("enviado");
      expect(await countMensajesEnviados(TEMPLATE_TRANSACCIONAL, "+5215500009001")).toBe(1);
    });
  });

  describe("(b) marketing SIN opt-in: 0 envíos", () => {
    it("guest existente pero SIN fila de consent → rechazado (409), 0 mensajes creados", async () => {
      const phone = "+5215500009002";
      await crearGuest(phone, "Huésped Sin Opt-in");

      const res = await enviar(phone, TEMPLATE_MARKETING);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("conflict");

      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0);
      // Tampoco debe quedar una aprobación "viva" prometiendo un envío que nunca podrá
      // ejecutarse: rechazado antes de tocar `agent_approval`.
      const { rows: aprobaciones } = await fixture.engine.admin.query(
        "select id from public.agent_approval where hotel_id = $1 and input_summary like $2;",
        [hotelId, `%${phone}%`],
      );
      expect(aprobaciones).toHaveLength(0);
    });

    it("teléfono sin NINGÚN guest asociado (deny-by-default) → rechazado, 0 mensajes creados", async () => {
      const phone = "+5215500009003";
      const res = await enviar(phone, TEMPLATE_MARKETING);
      expect(res.status).toBe(409);
      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0);
    });
  });

  describe("(c) marketing CON opt-in vigente (fecha/canal/texto registrados): el envío procede", () => {
    it("guest con consent(channel=whatsapp, consent_kind=marketing, granted=true) → pasa a aprobación y se ejecuta", async () => {
      const phone = "+5215500009004";
      const guestId = await crearGuest(phone, "Huésped Con Opt-in");
      await registrarOptIn({ guestId, channel: "whatsapp", granted: true });

      // Verifica que el opt-in quedó con fecha/canal/texto reales antes de seguir.
      const { rows: consentRows } = await fixture.engine.admin.query<{
        channel: string;
        granted: boolean;
        aviso_version: string;
        created_at: string;
      }>("select channel::text as channel, granted, aviso_version, created_at::text as created_at from public.consent where guest_id = $1;", [guestId]);
      expect(consentRows).toHaveLength(1);
      expect(consentRows[0]!.channel).toBe("whatsapp");
      expect(consentRows[0]!.granted).toBe(true);
      expect(consentRows[0]!.aviso_version).toContain("Acepto recibir promociones");
      expect(consentRows[0]!.created_at).toBeTruthy();

      const envio = await enviar(phone, TEMPLATE_MARKETING);
      expect(envio.status).toBe(202); // plantilla NO transaccional: sigue exigiendo aprobación humana (GOB-026), el opt-in solo desbloquea que PUEDA aprobarse
      const { aprobacionId } = (await envio.json()) as { aprobacionId: string };
      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0); // aún no aprobada

      const decidir = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo la promo de temporada alta." }),
      });
      expect(decidir.status).toBe(200);
      const decidido = (await decidir.json()) as { ejecutado: boolean };
      expect(decidido.ejecutado).toBe(true);

      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(1);

      // REQ-SEG-007: el mensaje REALMENTE persistido (lo que el huésped recibió) usa el
      // texto ya validado por el linter de plantillas -- el propio `message.body`
      // guardado demuestra que el envío incluyó la opción de baja, sin tener que
      // reconsultar la configuración por separado.
      const { rows: mensajeRows } = await fixture.engine.admin.query<{ body: string }>(
        `select m.body
         from public.message m
         join public.conversation c on c.id = m.conversation_id
         where m.hotel_id = $1 and m.template_name = $2 and m.direction = 'saliente' and c.guest_phone = $3;`,
        [hotelId, TEMPLATE_MARKETING, phone],
      );
      expect(mensajeRows).toHaveLength(1);
      expect(mensajeRows[0]!.body).toContain("BAJA");
      expect(mensajeRows[0]!.body).toBe(TEXTO_MARKETING_CON_BAJA);
    });
  });

  describe("(d) deny-by-default: opt-out explícito y opt-in de otro canal NO cuentan", () => {
    it("consent con granted=false (baja/opt-out) → sigue bloqueado, 0 envíos", async () => {
      const phone = "+5215500009005";
      const guestId = await crearGuest(phone, "Huésped Dado de Baja");
      await registrarOptIn({ guestId, channel: "whatsapp", granted: false });

      const res = await enviar(phone, TEMPLATE_MARKETING);
      expect(res.status).toBe(409);
      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0);
    });

    it("consent de marketing por canal 'web' (no whatsapp) → no autoriza el envío por WhatsApp, 0 envíos", async () => {
      const phone = "+5215500009006";
      const guestId = await crearGuest(phone, "Huésped Opt-in Solo Web");
      await registrarOptIn({ guestId, channel: "web", granted: true });

      const res = await enviar(phone, TEMPLATE_MARKETING);
      expect(res.status).toBe(409);
      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0);
    });
  });

  describe("(e) defensa en profundidad: una aprobación ya 'aprobada' sin opt-in tampoco ejecuta el envío", () => {
    it("una solicitud de marketing creada directo con ApprovalQueue.request() (sin pasar por el chequeo de la ruta HTTP) es bloqueada por tool.run() al aprobarse", async () => {
      const phone = "+5215500009007";
      await crearGuest(phone, "Huésped Simulando Bypass De Ruta");

      // Simula que la solicitud de aprobación la generó otra vía distinta a
      // routes/mensajeria.ts (p.ej. un agente vivo que llamó a la tool directo, ver
      // AgentRunner) -- usa el MISMO `ApprovalQueue.request()` real que usa esa otra vía
      // (nunca un INSERT manual que podría desincronizarse del esquema), sin pasar por
      // el chequeo temprano `isMarketingSendBlocked` de la ruta HTTP. Prueba que el
      // bloqueo real vive en `tool.run()` (agent-core), no solo en el atajo de la ruta.
      const approvalQueue = new PostgresApprovalQueue(fixture.engine.admin);
      const solicitud = await approvalQueue.request({
        toolName: SEND_WHATSAPP_TEMPLATE_TOOL_NAME,
        input: { guestPhone: phone, templateName: TEMPLATE_MARKETING, languageCode: "es", parameters: [] },
        orgId: fixture.seed.orgId,
        hotelId,
        requestedBy: `staff:bypass-directo:whatsapp-${phone}`,
        isMoney: false,
        textoMostrado: `Plantilla "${TEMPLATE_MARKETING}" a ${phone}: (sin parámetros)`,
        inputSummary: `Plantilla "${TEMPLATE_MARKETING}" a ${phone}: (sin parámetros)`,
      });
      expect(solicitud.status).toBe("pendiente");

      const decidir = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${solicitud.id}/decidir`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Aprobado sin saber que falta el opt-in." }),
      });
      // `tool.run()` lanza `MarketingOptInRequiredError` -> se mapea a 409, nunca a un
      // "ejecutado: true" silencioso.
      expect(decidir.status).toBe(409);
      const body = (await decidir.json()) as { code: string };
      expect(body.code).toBe("opt_in_marketing_requerido");

      expect(await countMensajesEnviados(TEMPLATE_MARKETING, phone)).toBe(0);
    });
  });

  describe("(f) linter de plantillas (REQ-SEG-007): marketing sin opción de baja → rechazado", () => {
    async function patchConfig(payload: unknown): Promise<Response> {
      return fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify(payload),
      });
    }

    async function getConfig(): Promise<{ plantillasMarketing: string[]; textosPlantillasMarketing: Record<string, string> }> {
      const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/config`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
      return res.json() as Promise<{ plantillasMarketing: string[]; textosPlantillasMarketing: Record<string, string> }>;
    }

    it("plantilla marketing con texto SIN opción de baja → 400, config sin cambios", async () => {
      const antes = await getConfig();
      const res = await patchConfig({
        plantillasMarketing: [...antes.plantillasMarketing, "promo_sin_baja"],
        textosPlantillasMarketing: {
          promo_sin_baja: "¡Aprovecha nuestra promoción exclusiva de fin de semana en el hotel!",
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("validation_error");

      const despues = await getConfig();
      expect(despues.plantillasMarketing).not.toContain("promo_sin_baja");
      expect(despues.textosPlantillasMarketing.promo_sin_baja).toBeUndefined();
    });

    it("plantilla marketing con texto VACÍO → 400, config sin cambios", async () => {
      const res = await patchConfig({
        plantillasMarketing: ["promo_vacia"],
        textosPlantillasMarketing: { promo_vacia: "   " },
      });
      // El propio schema (min(1) tras trim en Zod no aplica a espacios) puede rechazarla
      // como validación de forma o como fallo del linter -- ambos casos son un 400 antes
      // de guardar; lo que importa es que nunca quede clasificada como marketing.
      expect(res.status).toBe(400);
      const despues = await getConfig();
      expect(despues.plantillasMarketing).not.toContain("promo_vacia");
    });

    it("plantilla marketing SIN ningún texto registrado (ni nuevo ni previo) → 400", async () => {
      const res = await patchConfig({ plantillasMarketing: ["promo_sin_texto_alguno"] });
      expect(res.status).toBe(400);
      const despues = await getConfig();
      expect(despues.plantillasMarketing).not.toContain("promo_sin_texto_alguno");
    });

    it("plantilla marketing con texto CON opción de baja (variante 'STOP') → 200, queda clasificada", async () => {
      const res = await patchConfig({
        plantillasMarketing: ["promo_con_stop"],
        textosPlantillasMarketing: { promo_con_stop: "Special offer inside! Reply STOP to unsubscribe." },
      });
      expect(res.status).toBe(200);
      const despues = await getConfig();
      expect(despues.plantillasMarketing).toContain("promo_con_stop");
      expect(despues.textosPlantillasMarketing.promo_con_stop).toContain("STOP");
    });
  });
});
