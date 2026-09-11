// REQ-CRM-008 (embedded-postgres real): "programa de lealtad propio (tarifa directa
// con descuento, late checkout, crédito F&B, reconocimiento) gestionado desde
// CRM/WhatsApp" -- verificado con un huésped miembro obteniendo el beneficio
// configurado, contra la app real, sin mockear nada. La tarifa directa con descuento
// (REQ-RES-010) ya está cubierta end-to-end en
// tests/integration/reservas/club-segundo-viaje.spec.ts; este archivo cubre los 3
// beneficios que agrega este REQ (late checkout, crédito F&B, reconocimiento) más el
// caso negativo explícito del criterio (huésped NO miembro -> 0 beneficio).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("programa de lealtad -- beneficios (REQ-CRM-008)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let accountantToken: string;
  let hotelId: string;
  let miembroId: string;
  let noMiembroId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    accountantToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "accountant")!.email);

    const miembroRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Huésped Miembro Lealtad" }),
    });
    expect(miembroRes.status).toBe(201);
    miembroId = ((await miembroRes.json()) as { id: string }).id;

    const noMiembroRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Huésped Sin Inscribir" }),
    });
    expect(noMiembroRes.status).toBe(201);
    noMiembroId = ((await noMiembroRes.json()) as { id: string }).id;

    // Inscripción con consentimiento explícito (misma membresía que REQ-RES-010) --
    // el programa de lealtad completo (este REQ) vive sobre la MISMA fila de
    // membresía, no una separada.
    const inscripcion = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${miembroId}/club-segundo-viaje/inscripcion`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ avisoVersion: "v1", granted: true }),
    });
    expect(inscripcion.status).toBe(200);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function canjear(guestId: string, tipo: string, canal: string, token: string) {
    return fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/programa-lealtad/beneficios/${tipo}/canjear`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ canal }),
    });
  }

  it("GET config antes de configurar nada: los 3 beneficios están deshabilitados (null)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lateCheckoutHours: null, fnbCreditAmount: null, reconocimientoTexto: null });
  });

  it("miembro activo pero SIN configuración todavía: el canje de los 3 tipos se rechaza (409, fail-closed)", async () => {
    for (const tipo of ["late_checkout", "credito_fnb", "reconocimiento"]) {
      const res = await canjear(miembroId, tipo, "crm", gmToken);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("conflict");
    }
  });

  it("frontdesk NO puede configurar los beneficios (403, fuera de ADMIN_ROLES)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ lateCheckoutHours: 4 }),
    });
    expect(res.status).toBe(403);
  });

  it("owner/gm rechaza valores inválidos (0 horas de late checkout, crédito negativo, texto vacío)", async () => {
    const horasInvalidas = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ lateCheckoutHours: 0 }),
    });
    expect(horasInvalidas.status).toBe(400);

    const creditoInvalido = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fnbCreditAmount: -50 }),
    });
    expect(creditoInvalido.status).toBe(400);

    const textoInvalido = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ reconocimientoTexto: "   " }),
    });
    expect(textoInvalido.status).toBe(400);
  });

  it("owner/gm configura los 3 beneficios (PATCH parcial: un campo a la vez no borra los otros)", async () => {
    const r1 = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ lateCheckoutHours: 3 }),
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ lateCheckoutHours: 3, fnbCreditAmount: null, reconocimientoTexto: null });

    const r2 = await fixture.app.request(`/hoteles/${hotelId}/programa-lealtad/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fnbCreditAmount: 300, reconocimientoTexto: "Nota de bienvenida VIP al front desk." }),
    });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { lateCheckoutHours: number | null; fnbCreditAmount: number | null; reconocimientoTexto: string | null };
    // El campo que NO se mandó en este PATCH (lateCheckoutHours) sigue en 3, no se borró.
    expect(body2).toEqual({ lateCheckoutHours: 3, fnbCreditAmount: 300, reconocimientoTexto: "Nota de bienvenida VIP al front desk." });
  });

  it("huésped NO miembro: el canje de cualquier beneficio se rechaza aunque el hotel sí lo tenga configurado (409)", async () => {
    const res = await canjear(noMiembroId, "late_checkout", "crm", gmToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/membresía activa/);

    // Confirma que 0 fila de canje quedó registrada para el no-miembro.
    const estado = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${noMiembroId}/programa-lealtad`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect((await estado.json() as { canjes: unknown[] }).canjes).toEqual([]);
  });

  it("huésped miembro + beneficio configurado: obtiene el beneficio configurado (caso positivo central del criterio de aceptación)", async () => {
    const res = await canjear(miembroId, "late_checkout", "whatsapp", frontdeskToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { canjeado: boolean; tipo: string; canal: string; lateCheckoutHours: number };
    expect(body.canjeado).toBe(true);
    expect(body.tipo).toBe("late_checkout");
    expect(body.canal).toBe("whatsapp");
    expect(body.lateCheckoutHours).toBe(3);

    const creditoRes = await canjear(miembroId, "credito_fnb", "crm", gmToken);
    expect(creditoRes.status).toBe(201);
    const creditoBody = (await creditoRes.json()) as { fnbCreditAmount: number };
    expect(creditoBody.fnbCreditAmount).toBe(300);

    const reconocimientoRes = await canjear(miembroId, "reconocimiento", "crm", gmToken);
    expect(reconocimientoRes.status).toBe(201);
    const reconocimientoBody = (await reconocimientoRes.json()) as { reconocimientoTexto: string };
    expect(reconocimientoBody.reconocimientoTexto).toBe("Nota de bienvenida VIP al front desk.");

    // El estado del huésped refleja los 3 canjes reales, con su canal ('crm' o
    // 'whatsapp') -- la evidencia persistida de "gestionado desde CRM/WhatsApp".
    const estado = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${miembroId}/programa-lealtad`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(estado.status).toBe(200);
    const estadoBody = (await estado.json()) as { inscrito: boolean; canjes: { tipo: string; canal: string }[] };
    expect(estadoBody.inscrito).toBe(true);
    expect(estadoBody.canjes).toHaveLength(3);
    expect(estadoBody.canjes.map((c) => c.tipo).sort()).toEqual(["credito_fnb", "late_checkout", "reconocimiento"]);
    expect(estadoBody.canjes.find((c) => c.tipo === "late_checkout")!.canal).toBe("whatsapp");
  });

  it("revocada la membresía, un canje posterior vuelve a rechazarse (mismo fail-closed que el descuento de REQ-RES-010)", async () => {
    const revoke = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${miembroId}/club-segundo-viaje/revocar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(revoke.status).toBe(200);

    const res = await canjear(miembroId, "reconocimiento", "crm", gmToken);
    expect(res.status).toBe(409);
  });

  it("accountant NO puede canjear beneficios (403, fuera de MANAGE_RESERVATIONS_ROLES)", async () => {
    const res = await canjear(miembroId, "credito_fnb", "crm", accountantToken);
    expect(res.status).toBe(403);
  });

  it("tipo de beneficio inválido en la URL -> 400", async () => {
    const res = await canjear(miembroId, "tarifa_directa", "crm", gmToken);
    expect(res.status).toBe(400);
  });

  it("huésped inexistente -> 404, nunca crea un canje huérfano", async () => {
    const res = await canjear(crypto.randomUUID(), "late_checkout", "crm", gmToken);
    expect(res.status).toBe(404);
  });
});
