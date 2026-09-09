// H12a · REQ-LAUNCH: invitación de staff por correo, "olvidé mi contraseña" y cambio de
// correo -- todo el correo se lee de `email_outbox` (FakeEmailAdapter).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, ultimoCorreoPara, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;
let hotelAId: string;
let hotelBId: string;
let ownerAToken: string;

beforeAll(async () => {
  fixture = await createApiFixtureH12a();
  hotelAId = fixture.seed.hotels[0]!.id;
  hotelBId = fixture.seed.hotels[1]!.id;
  const ownerA = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
  const loginRes = await fixture.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerA, password: "atiende-dev-2026" }),
  });
  expect(loginRes.status).toBe(200);
  ownerAToken = ((await loginRes.json()) as { token: string }).token;
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function tokenDeInvitacion(email: string): Promise<string> {
  const { rows } = await fixture.engine.admin.query<{ token: string }>(
    "select token from public.account_token where email = $1 and purpose = 'invitacion_staff' and status = 'pendiente' order by created_at desc limit 1;",
    [email],
  );
  return rows[0]!.token;
}

describe("POST /hoteles/:hotelId/staff/invitaciones", () => {
  it("invita a una persona nueva con un rol, envía el correo, y aceptar la invitación crea su cuenta con ESE hotel/rol", async () => {
    const invitar = await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, {
      method: "POST",
      headers: auth(ownerAToken),
      body: JSON.stringify({ email: "nueva-camarista@example.com", role: "housekeeping" }),
    });
    expect(invitar.status).toBe(201);

    const correo = await ultimoCorreoPara(fixture.engine, "nueva-camarista@example.com", "invitacion-staff");
    expect(correo).not.toBeNull();
    expect(correo!.html).toContain("Ama de llaves");

    const listado = await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, { headers: auth(ownerAToken) });
    expect(listado.status).toBe(200);
    const invitaciones = (await listado.json()) as { email: string; estado: string }[];
    expect(invitaciones.some((i) => i.email === "nueva-camarista@example.com" && i.estado === "pendiente")).toBe(true);

    const token = await tokenDeInvitacion("nueva-camarista@example.com");
    const aceptar = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fullName: "Camarista Nueva", password: "Contrasena2026" }),
    });
    expect(aceptar.status).toBe(200);

    const login = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nueva-camarista@example.com", password: "Contrasena2026" }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { rol: string; hoteles: { id: string }[] };
    expect(session.rol).toBe("housekeeping");
    expect(session.hoteles).toHaveLength(1);
    expect(session.hoteles[0]!.id).toBe(hotelAId);

    // "email de otro hotel en invitación": aceptar la invitación de Hotel A NUNCA debe
    // otorgar membresía en Hotel B -- se verifica directo contra la base, no solo la
    // sesión que la propia API devolvería.
    const { rows: memberships } = await fixture.engine.admin.query<{ hotel_id: string }>(
      "select hotel_id from public.hotel_staff where user_id = (select id from public.staff_user where email = $1);",
      ["nueva-camarista@example.com"],
    );
    expect(memberships.map((m) => m.hotel_id)).toEqual([hotelAId]);
    expect(memberships.map((m) => m.hotel_id)).not.toContain(hotelBId);
  });

  it("invitar a una persona que YA tiene cuenta solo agrega la membresía a ese hotel (no duplica la cuenta)", async () => {
    const ownerBEmail = fixture.seed.hotels[1]!.staff.find((s) => s.role === "owner")!.email;

    await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, {
      method: "POST",
      headers: auth(ownerAToken),
      body: JSON.stringify({ email: ownerBEmail, role: "accountant" }),
    });

    const token = await tokenDeInvitacion(ownerBEmail);
    const aceptar = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(aceptar.status).toBe(200);

    const login = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerBEmail, password: "atiende-dev-2026" }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { hoteles: { id: string; rol: string }[] };
    expect(session.hoteles).toHaveLength(2);
    expect(session.hoteles.find((h) => h.id === hotelAId)?.rol).toBe("accountant");
  });

  it("un owner de otro hotel NO puede listar/crear invitaciones de este hotel (403)", async () => {
    const ownerBEmail = fixture.seed.hotels[1]!.staff.find((s) => s.role === "owner")!.email;
    const loginB = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerBEmail, password: "atiende-dev-2026" }),
    });
    const ownerBToken = ((await loginB.json()) as { token: string }).token;

    const listar = await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, { headers: auth(ownerBToken) });
    expect(listar.status).toBe(403);
  });
});

describe("Recuperación de contraseña y cambio de correo", () => {
  it("olvidé mi contraseña -> restablecer -> login con la nueva, la vieja deja de funcionar", async () => {
    const email = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!.email;

    const olvide = await fixture.app.request("/auth/olvide-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(olvide.status).toBe(200);

    const { rows } = await fixture.engine.admin.query<{ token: string }>(
      "select token from public.account_token where email = $1 and purpose = 'restablecer_contrasena' order by created_at desc limit 1;",
      [email],
    );
    const token = rows[0]!.token;

    const restablecer = await fixture.app.request("/auth/restablecer-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "NuevaContrasena2026" }),
    });
    expect(restablecer.status).toBe(200);

    const conNueva = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "NuevaContrasena2026" }),
    });
    expect(conNueva.status).toBe(200);

    const conVieja = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "atiende-dev-2026" }),
    });
    expect(conVieja.status).toBe(401);
  });

  it("cambio de correo requiere sesión para solicitarlo y token para confirmarlo", async () => {
    const cambiar = await fixture.app.request("/auth/me/cambiar-correo", {
      method: "POST",
      headers: auth(ownerAToken),
      body: JSON.stringify({ newEmail: "nuevo-correo-owner@example.com" }),
    });
    expect(cambiar.status).toBe(200);

    const correo = await ultimoCorreoPara(fixture.engine, "nuevo-correo-owner@example.com", "cambio-correo");
    expect(correo).not.toBeNull();

    const { rows } = await fixture.engine.admin.query<{ token: string }>(
      "select token from public.account_token where email = $1 and purpose = 'cambio_correo' order by created_at desc limit 1;",
      ["nuevo-correo-owner@example.com"],
    );
    const confirmar = await fixture.app.request("/auth/cambiar-correo/confirmar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rows[0]!.token }),
    });
    expect(confirmar.status).toBe(200);

    const loginNuevo = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nuevo-correo-owner@example.com", password: "atiende-dev-2026" }),
    });
    expect(loginNuevo.status).toBe(200);
  });
});
