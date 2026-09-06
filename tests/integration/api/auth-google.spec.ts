// H12a · REQ-LAUNCH: recorre el flujo COMPLETO de Google OAuth (Authorization Code +
// PKCE) contra un servidor OAuth FALSO local (tests/support/fakeGoogleOAuth.ts) --
// nunca red ni credenciales reales. Simula el único paso que en la vida real hace el
// navegador (seguir la redirección de "/auth/google/iniciar" hasta el authorize del
// proveedor): el resto (intercambio de código, verificación de id_token via JWKS) lo
// hace la API real por HTTP contra el servidor falso, exactamente como con Google real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "../../support/fakeGoogleOAuth.ts";

let fake: FakeGoogleOAuthServer;
let fixture: ApiFixtureH12a;

beforeAll(async () => {
  fake = await startFakeGoogleOAuthServer();
  fixture = await createApiFixtureH12a({
    GOOGLE_CLIENT_ID: fake.clientId,
    GOOGLE_CLIENT_SECRET: fake.clientSecret,
    GOOGLE_REDIRECT_URI: "http://localhost:3001/auth/google/callback",
    GOOGLE_OAUTH_BASE_URL: fake.baseUrl,
    GOOGLE_TOKEN_URL: fake.tokenUrl,
    GOOGLE_JWKS_URL: fake.jwksUrl,
    GOOGLE_ISSUER: fake.issuer,
    FRONTEND_URL: "http://localhost:5173",
  });
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
  await fake.close();
});

/** Simula el paso del navegador: sigue la redirección de /auth/google/iniciar hasta el
 *  authorize del proveedor (fake o real) y devuelve `{code, state}` de la redirección
 *  de vuelta. */
async function iniciarYAutorizar(qs: string): Promise<{ code: string; state: string }> {
  const iniciar = await fixture.app.request(`/auth/google/iniciar?${qs}`);
  expect(iniciar.status).toBe(302);
  const authorizeUrl = iniciar.headers.get("location")!;
  expect(authorizeUrl).toContain(fake.baseUrl);

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  expect(authorizeRes.status).toBe(302);
  const backToUs = new URL(authorizeRes.headers.get("location")!);
  return { code: backToUs.searchParams.get("code")!, state: backToUs.searchParams.get("state")! };
}

describe("GET /auth/google/iniciar + /auth/google/callback -- flujo feliz", () => {
  it("login: vincula la identidad de Google a un staff_user YA existente e inicia sesión", async () => {
    const ownerEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
    fake.setNextUser({ sub: "sub-owner-1", email: ownerEmail, emailVerified: true, name: "Owner Demo" });

    const { code, state } = await iniciarYAutorizar("purpose=login");
    const callback = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!);
    expect(location.origin).toBe("http://localhost:5173");
    expect(location.pathname).toBe("/auth/google/callback");
    expect(location.searchParams.get("token")).toBeTruthy();
    expect(location.searchParams.get("email")).toBe(ownerEmail);

    // La identidad quedó vinculada -- un segundo login con el MISMO sub reutiliza la
    // vinculación (no intenta crear una cuenta nueva ni falla por duplicado).
    fake.setNextUser({ sub: "sub-owner-1", email: ownerEmail, emailVerified: true, name: "Owner Demo" });
    const second = await iniciarYAutorizar("purpose=login");
    const secondCallback = await fixture.app.request(`/auth/google/callback?code=${second.code}&state=${second.state}`);
    expect(secondCallback.status).toBe(302);
    expect(new URL(secondCallback.headers.get("location")!).searchParams.get("token")).toBeTruthy();
  });

  it("registro: crea org+hotel+owner nuevos y envía el correo de bienvenida", async () => {
    fake.setNextUser({ sub: "sub-nuevo-hotel-1", email: "nueva@hotelnuevo.example", emailVerified: true, name: "Nueva Dueña" });

    const { code, state } = await iniciarYAutorizar(
      "purpose=registro&hotelName=" + encodeURIComponent("Hotel Amanecer") + "&city=Merida&stateName=Yucatan",
    );
    const callback = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!);
    expect(location.searchParams.get("token")).toBeTruthy();
    expect(location.searchParams.get("email")).toBe("nueva@hotelnuevo.example");

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.staff_user where email = $1 and email_verified_at is not null and created_via = 'google';",
      ["nueva@hotelnuevo.example"],
    );
    expect(rows.length).toBe(1);

    const { rows: emailRows } = await fixture.engine.admin.query<{ template: string }>(
      "select template from public.email_outbox where to_email = $1;",
      ["nueva@hotelnuevo.example"],
    );
    expect(emailRows.map((r) => r.template)).toContain("bienvenida-hotel");
  });
});

describe("GET /auth/google/iniciar -- sin configurar", () => {
  it("responde 503 no_configurado cuando faltan credenciales de Google", async () => {
    const sinConfigurar = await createApiFixtureH12a({});
    try {
      const res = await sinConfigurar.app.request("/auth/google/iniciar?purpose=login");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("no_configurado");
    } finally {
      await destroyApiFixtureH12a(sinConfigurar);
    }
  });
});
