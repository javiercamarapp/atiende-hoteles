// H12a · REQ-LAUNCH: adversariales explícitos del encargo -- "token reutilizado,
// expirado, ... email de otro hotel en invitación" -- para invitación de staff y
// restablecimiento de contraseña.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;
let hotelAId: string;
let ownerAToken: string;

beforeAll(async () => {
  fixture = await createApiFixtureH12a();
  hotelAId = fixture.seed.hotels[0]!.id;
  const ownerA = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
  const loginRes = await fixture.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerA, password: "atiende-dev-2026" }),
  });
  ownerAToken = ((await loginRes.json()) as { token: string }).token;
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function invitar(email: string, role = "housekeeping") {
  return fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, {
    method: "POST",
    headers: auth(ownerAToken),
    body: JSON.stringify({ email, role }),
  });
}

async function tokenDeInvitacion(email: string): Promise<{ id: string; token: string }> {
  const { rows } = await fixture.engine.admin.query<{ id: string; token: string }>(
    "select id, token from public.account_token where email = $1 and purpose = 'invitacion_staff' order by created_at desc limit 1;",
    [email],
  );
  return rows[0]!;
}

describe("adversarial · invitación de staff", () => {
  it("token de invitación reutilizado -> la segunda aceptación se rechaza (409)", async () => {
    await invitar("reuso-invitacion@example.com");
    const { token } = await tokenDeInvitacion("reuso-invitacion@example.com");

    const primero = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fullName: "Persona", password: "Contrasena2026" }),
    });
    expect(primero.status).toBe(200);

    const segundo = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fullName: "Persona", password: "Contrasena2026" }),
    });
    expect(segundo.status).toBe(409);
  });

  it("token de invitación expirado -> se rechaza, no crea ninguna cuenta", async () => {
    await invitar("expirada-invitacion@example.com");
    const { id, token } = await tokenDeInvitacion("expirada-invitacion@example.com");
    await fixture.engine.admin.query("update public.account_token set expires_at = now() - interval '1 day' where id = $1;", [id]);

    const res = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fullName: "Persona", password: "Contrasena2026" }),
    });
    expect(res.status).toBe(409);

    const { rows } = await fixture.engine.admin.query<{ id: string }>("select id from public.staff_user where email = $1;", [
      "expirada-invitacion@example.com",
    ]);
    expect(rows.length).toBe(0);
  });

  it("invitación revocada -> aceptarla después se rechaza", async () => {
    await invitar("revocada-invitacion@example.com");
    const listado = await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones`, { headers: auth(ownerAToken) });
    const invitaciones = (await listado.json()) as { id: string; email: string }[];
    const invitacionId = invitaciones.find((i) => i.email === "revocada-invitacion@example.com")!.id;

    const revocar = await fixture.app.request(`/hoteles/${hotelAId}/staff/invitaciones/${invitacionId}`, {
      method: "DELETE",
      headers: auth(ownerAToken),
    });
    expect(revocar.status).toBe(200);

    const { token } = await tokenDeInvitacion("revocada-invitacion@example.com");
    const aceptar = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fullName: "Persona", password: "Contrasena2026" }),
    });
    expect(aceptar.status).toBe(409);
  });

  it("token de invitación inexistente -> 404", async () => {
    const res = await fixture.app.request("/registro/invitacion/aceptar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-invitacion-que-nunca-existio", fullName: "Persona X", password: "Contrasena2026" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("adversarial · restablecer contraseña", () => {
  it("token de reset reutilizado -> la segunda vez se rechaza y no cambia la contraseña otra vez", async () => {
    const email = fixture.seed.hotels[0]!.staff.find((s) => s.role === "reservations")!.email;
    await fixture.app.request("/auth/olvide-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const { rows } = await fixture.engine.admin.query<{ token: string }>(
      "select token from public.account_token where email = $1 and purpose = 'restablecer_contrasena' order by created_at desc limit 1;",
      [email],
    );
    const token = rows[0]!.token;

    const primero = await fixture.app.request("/auth/restablecer-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "PrimeraNueva2026" }),
    });
    expect(primero.status).toBe(200);

    const segundo = await fixture.app.request("/auth/restablecer-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "SegundaNueva2026" }),
    });
    expect(segundo.status).toBe(409);

    // La contraseña sigue siendo la del PRIMER restablecimiento -- el segundo intento
    // (rechazado) no tuvo ningún efecto.
    const login = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "PrimeraNueva2026" }),
    });
    expect(login.status).toBe(200);
  });

  it("solicitar reset para un correo que no existe responde 200 genérico (sin enumeración) y no crea ningún token", async () => {
    const res = await fixture.app.request("/auth/olvide-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "no-existe-nadie@example.com" }),
    });
    expect(res.status).toBe(200);
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.account_token where email = $1 and purpose = 'restablecer_contrasena';",
      ["no-existe-nadie@example.com"],
    );
    expect(rows.length).toBe(0);
  });
});
