// H12a · REQ-LAUNCH: casos adversariales exigidos por el encargo para Google OAuth --
// "incluidos state inválido, nonce repetido, email no verificado, cuenta no invitada ->
// rechazo" -- cada uno contra el servidor OAuth FALSO local, nunca contra Google real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../support/api-fixture-h12a.ts";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "../support/fakeGoogleOAuth.ts";

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

async function iniciar(qs: string): Promise<string> {
  const res = await fixture.app.request(`/auth/google/iniciar?${qs}`);
  expect(res.status).toBe(302);
  return res.headers.get("location")!;
}

function googleError(location: string): string | null {
  return new URL(location).searchParams.get("google_error");
}

describe("adversarial · Google OAuth", () => {
  it("state inválido (jamás emitido por esta API) -> rechazo, nunca inicia sesión", async () => {
    const callback = await fixture.app.request("/auth/google/callback?code=cualquiera&state=un-state-que-nunca-existio");
    expect(callback.status).toBe(302);
    expect(googleError(callback.headers.get("location")!)).toBe("state_invalido");
  });

  it("state reutilizado (replay del mismo callback dos veces) -> la segunda vez se rechaza", async () => {
    const ownerEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
    fake.setNextUser({ sub: "sub-replay-1", email: ownerEmail, emailVerified: true });

    const authorizeUrl = await iniciar("purpose=login");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const backToUs = new URL(authorizeRes.headers.get("location")!);
    const code = backToUs.searchParams.get("code")!;
    const state = backToUs.searchParams.get("state")!;

    const first = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!).searchParams.get("token")).toBeTruthy();

    const second = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(second.status).toBe(302);
    expect(googleError(second.headers.get("location")!)).toBe("state_ya_usado");
  });

  it("nonce que no coincide con el solicitado -> rechazo, ninguna sesión emitida", async () => {
    fake.setNextUser({ sub: "sub-nonce-mismatch-1", email: "nonce-mismatch@example.com", emailVerified: true });

    // `test_force_nonce` es una palanca EXCLUSIVA del servidor falso de pruebas (nunca
    // algo que Google real exponga): fuerza que el id_token devuelto lleve un nonce
    // DISTINTO al que esta API pidió, simulando una confusión/replay de sesión.
    const iniciarRes = await fixture.app.request("/auth/google/iniciar?purpose=login");
    const authorizeUrl = new URL(iniciarRes.headers.get("location")!);
    authorizeUrl.searchParams.set("test_force_nonce", "nonce-que-no-coincide");

    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: "manual" });
    const backToUs = new URL(authorizeRes.headers.get("location")!);
    const code = backToUs.searchParams.get("code")!;
    const state = backToUs.searchParams.get("state")!;

    const callback = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    expect(googleError(callback.headers.get("location")!)).toBe("nonce_invalido");

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.staff_user where email = $1;",
      ["nonce-mismatch@example.com"],
    );
    expect(rows.length).toBe(0);
  });

  it("correo no verificado por Google -> rechazo, ninguna sesión emitida", async () => {
    fake.setNextUser({ sub: "sub-no-verificado-1", email: "sinverificar@example.com", emailVerified: false });

    const authorizeUrl = await iniciar("purpose=login");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const backToUs = new URL(authorizeRes.headers.get("location")!);
    const code = backToUs.searchParams.get("code")!;
    const state = backToUs.searchParams.get("state")!;

    const callback = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    expect(googleError(callback.headers.get("location")!)).toBe("correo_no_verificado");
  });

  it("cuenta no invitada (purpose=login, sin staff_user con ese correo) -> rechazo, no crea nada", async () => {
    fake.setNextUser({ sub: "sub-no-invitado-1", email: "extranio@example.com", emailVerified: true });

    const authorizeUrl = await iniciar("purpose=login");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const backToUs = new URL(authorizeRes.headers.get("location")!);
    const code = backToUs.searchParams.get("code")!;
    const state = backToUs.searchParams.get("state")!;

    const callback = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(callback.status).toBe(302);
    expect(googleError(callback.headers.get("location")!)).toBe("cuenta_no_invitada");

    const { rows } = await fixture.engine.admin.query<{ id: string }>("select id from public.staff_user where email = $1;", ["extranio@example.com"]);
    expect(rows.length).toBe(0);
  });

  it("código de autorización reutilizado (segundo intercambio del MISMO code) -> el proveedor lo rechaza", async () => {
    fake.setNextUser({ sub: "sub-code-reuso-1", email: "codereuso@example.com", emailVerified: true });
    const authorizeUrl = await iniciar("purpose=registro&hotelName=Hotel+Reuso&city=CDMX&stateName=CDMX");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const backToUs = new URL(authorizeRes.headers.get("location")!);
    const code = backToUs.searchParams.get("code")!;
    const state = backToUs.searchParams.get("state")!;

    const first = await fixture.app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(new URL(first.headers.get("location")!).searchParams.get("token")).toBeTruthy();

    // Un `state` nuevo y todavía pendiente (otra sesión de "iniciar" distinta)
    // intentando reusar el MISMO `code` ya canjeado en el flujo anterior -- el
    // `code_verifier` de este segundo `state` no coincide con el PKCE `code_challenge`
    // que el proveedor asoció a ese `code`, así que el intercambio se rechaza.
    fake.setNextUser({ sub: "sub-code-reuso-1", email: "codereuso@example.com", emailVerified: true });
    const segundoIniciarRes = await fixture.app.request("/auth/google/iniciar?purpose=login");
    const segundoState = new URL(segundoIniciarRes.headers.get("location")!).searchParams.get("state");

    const reused = await fixture.app.request(`/auth/google/callback?code=${code}&state=${segundoState}`);
    expect(reused.status).toBe(302);
    expect(googleError(reused.headers.get("location")!)).not.toBeNull();
  });
});
