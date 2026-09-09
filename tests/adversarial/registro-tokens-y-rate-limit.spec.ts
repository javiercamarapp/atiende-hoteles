// H12a · REQ-LAUNCH: adversariales explícitos del encargo para el alta autoservicio --
// "token reutilizado, expirado, ... rate limit de registro".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;

beforeAll(async () => {
  // Límite bajo (3/hora) para poder ejercitar el 429 sin 6+ llamadas de más.
  fixture = await createApiFixtureH12a({ RATE_LIMIT_REGISTRO_POR_IP_POR_HORA: "3" });
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

async function registrar(email: string) {
  return fixture.app.request("/registro", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hotelName: "Hotel Adversarial",
      city: "Tulum",
      stateName: "Quintana Roo",
      ownerFullName: "Persona De Prueba",
      ownerEmail: email,
      password: "Contrasena2026",
    }),
  });
}

describe("adversarial · verificación de correo", () => {
  it("token de verificación reutilizado -> la segunda vez se rechaza (409)", async () => {
    await registrar("reuso-verificacion@example.com");
    const { rows } = await fixture.engine.admin.query<{ token: string }>(
      "select token from public.account_token where email = $1 and purpose = 'verificar_correo';",
      ["reuso-verificacion@example.com"],
    );
    const token = rows[0]!.token;

    const primero = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(primero.status).toBe(200);

    const segundo = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(segundo.status).toBe(409);
  });

  it("token de verificación expirado -> se rechaza, la cuenta sigue sin poder iniciar sesión", async () => {
    await registrar("expirado-verificacion@example.com");
    const { rows } = await fixture.engine.admin.query<{ id: string; token: string }>(
      "select id, token from public.account_token where email = $1 and purpose = 'verificar_correo';",
      ["expirado-verificacion@example.com"],
    );
    const { id, token } = rows[0]!;
    await fixture.engine.admin.query("update public.account_token set expires_at = now() - interval '1 hour' where id = $1;", [id]);

    const res = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(409);

    const login = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "expirado-verificacion@example.com", password: "Contrasena2026" }),
    });
    expect(login.status).toBe(403);
  });

  it("token de verificación inexistente -> 404", async () => {
    const res = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-que-nunca-existio-00000000000000000000000000000000" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("adversarial · rate limit de POST /registro", () => {
  // Límite compartido con el resto del archivo (mismo `fixture`, mismo `registroLimiter`
  // en memoria vivo durante toda la suite): el bloque anterior YA consumió 2 llamadas
  // (`reuso-verificacion@`/`expirado-verificacion@`) contra el límite de 3/hora
  // configurado en `beforeAll` -- una instancia AISLADA (fixture propia) hace la prueba
  // determinista sin depender del orden/cantidad de pruebas previas del archivo.
  let aislado: ApiFixtureH12a;

  beforeAll(async () => {
    aislado = await createApiFixtureH12a({ RATE_LIMIT_REGISTRO_POR_IP_POR_HORA: "3" });
  });

  afterAll(async () => {
    await destroyApiFixtureH12a(aislado);
  });

  async function registrarAislado(email: string) {
    return aislado.app.request("/registro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hotelName: "Hotel Adversarial",
        city: "Tulum",
        stateName: "Quintana Roo",
        ownerFullName: "Persona De Prueba",
        ownerEmail: email,
        password: "Contrasena2026",
      }),
    });
  }

  it("la N+1 solicitud sobre el límite configurado responde 429 con Retry-After", async () => {
    const r1 = await registrarAislado("limite-1@example.com");
    const r2 = await registrarAislado("limite-2@example.com");
    const r3 = await registrarAislado("limite-3@example.com");
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);

    const r4 = await registrarAislado("limite-4@example.com");
    expect(r4.status).toBe(429);
    expect(r4.headers.get("retry-after")).toBeTruthy();

    // La cuenta 4 NUNCA se creó -- el límite se aplicó ANTES de tocar la base.
    const { rows } = await aislado.engine.admin.query<{ id: string }>("select id from public.staff_user where email = $1;", [
      "limite-4@example.com",
    ]);
    expect(rows.length).toBe(0);
  });
});
