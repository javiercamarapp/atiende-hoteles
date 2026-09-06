// H12a · Servidor OAuth de Google FALSO, para pruebas de integración/adversariales del
// flujo real de `routes/auth-google.ts` SIN red ni credenciales reales (REQ-LAUNCH
// exige poder recorrer el flujo completo, incluidos state inválido/nonce
// repetido/correo no verificado, de forma determinista). Implementa un servidor HTTP
// real (node:http) con las 3 piezas mínimas de un Authorization Server OIDC:
//   - GET  /o/oauth2/v2/auth  -- "autoriza" sin interacción humana (esto es una prueba,
//     no un navegador) y redirige de vuelta con `code`+`state`, exactamente como
//     Google haría tras el consentimiento del usuario.
//   - POST /token             -- valida `client_secret`+PKCE (`code_verifier` contra el
//     `code_challenge` que se guardó en `/auth`) y devuelve un `id_token` FIRMADO con
//     una clave RSA de prueba generada al vuelo (RS256, igual que Google real).
//   - GET  /jwks.json         -- el JWKS público correspondiente a esa clave.
//
// `setNextUser()` fija el perfil (sub/email/email_verified) que este servidor falso va
// a "autenticar" en la SIGUIENTE llamada a `/auth` -- así cada prueba controla
// exactamente qué identidad de Google vuelve. `authorizeUrl` permite forzar un `nonce`
// distinto al pedido por el cliente (`forceNonce` en la query) -- exclusivo para el
// escenario adversarial "nonce no coincide" (nunca algo que el flujo real de Google
// exponga, es una palanca de prueba).
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, SignJWT, generateKeyPair } from "jose";

export interface FakeGoogleUser {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

interface PendingAuthorization {
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  user: FakeGoogleUser;
  used: boolean;
}

export interface FakeGoogleOAuthServer {
  /** Base URL del servidor falso, p. ej. `http://127.0.0.1:54123`. Úsalo para
   *  `env.googleOAuthBaseUrl` (el authorize vive en `/o/oauth2/v2/auth`, mismo path que
   *  Google real, así que `buildAuthorizationUrl` no necesita ninguna rama especial). */
  baseUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** El emisor (`iss`) que este servidor firma en cada id_token -- debe usarse como
   *  `env.googleIssuer` en la prueba. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  setNextUser(user: FakeGoogleUser): void;
  close(): Promise<void>;
}

export async function startFakeGoogleOAuthServer(): Promise<FakeGoogleOAuthServer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = randomUUID();
  const jwk = await exportJWK(publicKey);

  const clientId = "fake-google-client-id";
  const clientSecret = "fake-google-client-secret";
  const pendingByCode = new Map<string, PendingAuthorization>();
  let nextUser: FakeGoogleUser = { sub: "fake-sub-default", email: "default@example.com", emailVerified: true };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fake_server_error", message: err instanceof Error ? err.message : String(err) }));
    });
  });

  async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const codeChallenge = url.searchParams.get("code_challenge");
      const forceNonce = url.searchParams.get("test_force_nonce");
      if (!redirectUri || !state || !nonce || !codeChallenge) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }

      const code = randomBytes(24).toString("hex");
      pendingByCode.set(code, {
        redirectUri,
        nonce: forceNonce ?? nonce,
        codeChallenge,
        user: nextUser,
        used: false,
      });

      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const code = params.get("code") ?? "";
      const receivedClientId = params.get("client_id");
      const receivedClientSecret = params.get("client_secret");
      const codeVerifier = params.get("code_verifier") ?? "";
      const redirectUri = params.get("redirect_uri");

      const pending = pendingByCode.get(code);
      if (!pending || pending.used || receivedClientId !== clientId || receivedClientSecret !== clientSecret || redirectUri !== pending.redirectUri) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }

      const { createHash } = await import("node:crypto");
      const expectedChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (expectedChallenge !== pending.codeChallenge) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "pkce_verification_failed" }));
        return;
      }

      pending.used = true;

      const idToken = await new SignJWT({
        email: pending.user.email,
        email_verified: pending.user.emailVerified,
        name: pending.user.name,
        nonce: pending.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuedAt()
        .setIssuer(server_issuer())
        .setAudience(clientId)
        .setSubject(pending.user.sub)
        .setExpirationTime("10m")
        .sign(privateKey);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id_token: idToken, access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 3600 }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  let issuer = "";
  function server_issuer(): string {
    return issuer;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  issuer = baseUrl;

  return {
    baseUrl,
    tokenUrl: `${baseUrl}/token`,
    jwksUrl: `${baseUrl}/jwks.json`,
    issuer,
    clientId,
    clientSecret,
    setNextUser(user: FakeGoogleUser) {
      nextUser = user;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
