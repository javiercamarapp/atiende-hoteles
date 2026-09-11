// REQ-AGT-010 (P1/SEG): "El sistema debe implementar rate limits por número/tenant/país
// y exigir OTP para cambios de datos sensibles del huésped." Criterio de aceptación
// literal (docs/ACEPTACION.md): "solicitud N+1 sobre el límite configurado → 429; cambio
// sin OTP → rechazado."
//
// La mitad OTP (REQ-HUE-023) ya existía antes de este archivo -- `guestContactChangeOtp.ts`
// y la ruta `POST .../huespedes/:guestId/contacto/solicitudes(/confirmar)`, probadas en
// detalle (los 6 desenlaces de `evaluateOtpConfirmation`) en
// tests/adversarial/guardrails-conversacionales.spec.ts. Este archivo NO repite esa
// matriz completa -- solo confirma, una vez, que "sin OTP correcto no hay cambio" sigue
// vigente aquí (última prueba de este archivo), y se concentra en la pieza que SÍ
// faltaba: el límite de tasa con clave (número, tenant, país)
// (`buildGuestContactOtpRateLimitKey`, packages/domain-hotel/src/guestContactChangeOtp.ts)
// aplicado en `apps/api/src/routes/huespedes.ts` antes de generar el OTP/tocar la
// base/llamar a WhatsApp.
//
// Se usa `createApiFixtureH12a` (no el fixture compartido `api-fixture.ts`, que las
// instrucciones de la tarea piden no tocar) porque necesita overridear
// RATE_LIMIT_OTP_CONTACTO_POR_NUMERO_TENANT_PAIS_POR_HORA a un valor bajo para poder
// ejercitar el 429 real sin decenas de llamadas de más -- mismo criterio que
// tests/adversarial/registro-tokens-y-rate-limit.spec.ts con
// RATE_LIMIT_REGISTRO_POR_IP_POR_HORA.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@atiende-hoteles/db";
import { sharedWhatsappAdapter } from "@atiende-hoteles/api";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../support/api-fixture-h12a.ts";
import { loginAs } from "../support/api-fixture.ts";

const LIMITE = 3;

describe("adversarial · rate limit de OTP de cambio de contacto (REQ-AGT-010)", () => {
  let fixture: ApiFixtureH12a;
  let hotelId: string;
  let staffToken: string;

  beforeAll(async () => {
    fixture = await createApiFixtureH12a({ RATE_LIMIT_OTP_CONTACTO_POR_NUMERO_TENANT_PAIS_POR_HORA: String(LIMITE) });
    hotelId = fixture.seed.hotels[0]!.id;
    staffToken = await loginAs(fixture.app, fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixtureH12a(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function crearHuesped(token: string, telefono: string, nombre = "Huésped de prueba"): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ nombre, telefono }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  async function solicitarCambio(token: string, guestId: string, valorNuevo: string) {
    return fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/contacto/solicitudes`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ campo: "telefono", valorNuevo }),
    });
  }

  it(`la solicitud N+1 (N=${LIMITE}) sobre el límite configurado para el MISMO (número, tenant, país) responde 429 con Retry-After, sin generar un OTP nuevo ni llamar a WhatsApp`, async () => {
    const telefonoOriginal = "+5219980000001";
    const guestId = await crearHuesped(staffToken, telefonoOriginal, "Huésped Límite Excedido");
    const spy = vi.spyOn(sharedWhatsappAdapter, "sendTemplateMessage");
    const llamadasAntes = spy.mock.calls.length;

    for (let i = 1; i <= LIMITE; i += 1) {
      const res = await solicitarCambio(staffToken, guestId, `+52199900000${i}`);
      expect(res.status).toBe(201);
    }
    expect(spy.mock.calls.length).toBe(llamadasAntes + LIMITE);

    const siguiente = await solicitarCambio(staffToken, guestId, "+5219999999999");
    expect(siguiente.status).toBe(429);
    expect(siguiente.headers.get("retry-after")).toBeTruthy();
    const body = (await siguiente.json()) as { code: string };
    expect(body.code).toBe("rate_limited");

    // Fail-closed ANTES de tocar la base o WhatsApp: la solicitud N+1 no generó un OTP
    // nuevo (0 llamadas adicionales al adaptador de mensajería)...
    expect(spy.mock.calls.length).toBe(llamadasAntes + LIMITE);
    // ...ni insertó una fila nueva en guest_contact_change_request.
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.guest_contact_change_request where guest_id = $1;",
      [guestId],
    );
    expect(Number(rows[0]!.count)).toBe(LIMITE);

    spy.mockRestore();
  });

  it("un número DISTINTO en el MISMO tenant/hotel no comparte balde con un número ya al límite (dimensión 'número')", async () => {
    // El bloque anterior ya agotó el balde de "+5219980000001" para este tenant/hotel --
    // un huésped con un número MX distinto en el MISMO tenant debe poder solicitar su
    // propio OTP sin verse afectado, o el límite estaría agrupando por tenant+país
    // solamente, no por número (lo que exige el criterio literal).
    const otroTelefono = "+5219980009999";
    const guestId = await crearHuesped(staffToken, otroTelefono, "Huésped Número Distinto");
    const res = await solicitarCambio(staffToken, guestId, "+5219980008888");
    expect(res.status).toBe(201);
  });

  it("el MISMO número bajo un tenant DISTINTO no comparte balde (dimensión 'tenant')", async () => {
    // Segunda org/hotel/staff REAL (mismo criterio que
    // tests/adversarial/aislamiento-tenant-hotel.spec.ts) -- no un mock: la clave del
    // límite depende de `tenant_id` real (`c.get("orgId")`), así que hace falta un
    // tenant real ajeno para probar que no lo ignora.
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Org Ajena Rate-Limit') returning id;",
    );
    const otroOrgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Ajeno Rate-Limit') returning id;",
      [otroOrgId],
    );
    const otroHotelId = locRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [otroHotelId, otroOrgId]);
    const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ('gm@otra-org-ratelimit.demo', 'GM Ajeno', $1) returning id;",
      [await hashPassword("otra-org-pass")],
    );
    const otroUserId = userRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'gm');",
      [otroOrgId, otroHotelId, otroUserId],
    );
    const otroToken = await loginAs(fixture.app, "gm@otra-org-ratelimit.demo", "otra-org-pass");

    // MISMO número que ya agotó su límite en el primer tenant (+5219980000001).
    const { rows: guestRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name, phone) values ($1, $2, 'Huésped Tenant Ajeno', $3) returning id;",
      [otroOrgId, otroHotelId, "+5219980000001"],
    );
    const guestIdAjeno = guestRows[0]!.id;

    const res = await fixture.app.request(`/hoteles/${otroHotelId}/huespedes/${guestIdAjeno}/contacto/solicitudes`, {
      method: "POST",
      headers: auth(otroToken),
      body: JSON.stringify({ campo: "telefono", valorNuevo: "+5219980007777" }),
    });
    expect(res.status).toBe(201);
  });

  it("un número de OTRO país en el MISMO tenant/hotel no comparte balde (dimensión 'país')", async () => {
    const telefonoUs = "+14155550001";
    const guestId = await crearHuesped(staffToken, telefonoUs, "Huésped País Distinto");
    const res = await solicitarCambio(staffToken, guestId, "+14155559999");
    expect(res.status).toBe(201);
  });

  it("cambio de contacto sin OTP correcto se rechaza y NO modifica guest.phone (mitad OTP del criterio, REQ-HUE-023)", async () => {
    const telefonoOriginal = "+5219980001234";
    const guestId = await crearHuesped(staffToken, telefonoOriginal, "Huésped Sin OTP");

    const solicitud = await solicitarCambio(staffToken, guestId, "+5219989998888");
    expect(solicitud.status).toBe(201);
    const { requestId } = (await solicitud.json()) as { requestId: string };

    const confirmacion = await fixture.app.request(
      `/hoteles/${hotelId}/huespedes/${guestId}/contacto/solicitudes/${requestId}/confirmar`,
      { method: "POST", headers: auth(staffToken), body: JSON.stringify({ codigo: "000000" }) },
    );
    expect(confirmacion.status).toBe(409);

    const { rows } = await fixture.engine.admin.query<{ phone: string }>("select phone from public.guest where id = $1;", [guestId]);
    expect(rows[0]!.phone).toBe(telefonoOriginal);
  });
});
