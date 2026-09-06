// H12a · REQ-LAUNCH: Google OAuth 2.0 Authorization Code + PKCE (RFC 7636) -- helpers
// puros de criptografía/protocolo, sin tocar la base de datos (eso vive en
// routes/auth-google.ts). Todas las URLs de Google (`tokenUrl`/`jwksUrl`/`issuer`) son
// PARÁMETROS, nunca constantes hardcodeadas aquí -- así las pruebas de integración
// pueden apuntar exactamente esta misma lógica contra un servidor OAuth FALSO local
// (tests/support/fakeGoogleOAuth.ts) y recorrer el flujo completo (incluidos los casos
// adversariales: state inválido, nonce repetido/no coincidente, correo no verificado)
// sin red ni credenciales reales -- ver apps/api/src/env.ts (`googleOAuthBaseUrl`/
// `googleTokenUrl`/`googleJwksUrl`/`googleIssuer`).
import { randomBytes, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE `code_verifier`: 43-128 caracteres, RFC 7636 §4.1. Se genera con 32 bytes de
 *  entropía real (`crypto.randomBytes`), nunca `Math.random()`. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** PKCE `code_challenge` método S256 (RFC 7636 §4.2) -- el único método que este
 *  cliente ofrece a Google (`plain` no se usa nunca: es el método débil). */
export function computeCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

/** `state` (anti-CSRF, RFC 6749 §10.12) -- 32 bytes de entropía, codificados en hex
 *  para viajar sin problemas en un query string sin URL-encoding especial. */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

/** `nonce` (anti-replay del id_token, OpenID Connect Core §3.1.2.1) -- se compara byte
 *  a byte contra el claim `nonce` del id_token devuelto por Google en el intercambio de
 *  código; un id_token con un nonce distinto al que ESTE servidor pidió se rechaza
 *  siempre, sin importar que la firma del token sea válida (evita que un id_token
 *  robado/reutilizado de otra sesión sirva aquí). */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export interface GoogleTokenResponse {
  idToken: string;
  accessToken: string;
}

export class GoogleOAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

/** Intercambia el `code` de autorización por tokens (RFC 6749 §4.1.3 + PKCE §4.5).
 *  `tokenUrl` es inyectable (ver arriba) -- en pruebas apunta al servidor OAuth falso. */
export async function exchangeAuthorizationCode(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  let res: Response;
  try {
    res = await fetch(opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: opts.redirectUri,
        code_verifier: opts.codeVerifier,
      }),
    });
  } catch (err) {
    throw new GoogleOAuthError("google_no_disponible", `No se pudo contactar al endpoint de token de Google: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleOAuthError("codigo_invalido", `Google rechazó el intercambio de código (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { id_token?: string; access_token?: string };
  if (!json.id_token || !json.access_token) {
    throw new GoogleOAuthError("respuesta_invalida", "La respuesta de token de Google no incluyó id_token/access_token.");
  }
  return { idToken: json.id_token, accessToken: json.access_token };
}

export interface GoogleIdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  nonce?: string;
  name?: string;
  exp: number;
  iat: number;
}

// Un `JWKSet` remoto cachea sus claves en memoria por su propia lógica interna de
// `cacheMaxAge` -- se guarda UNA instancia por `jwksUrl` (no una nueva por request) para
// que ese caché sea efectivo; distinto `jwksUrl` (p. ej. el servidor OAuth falso de
// pruebas) obtiene su propia instancia, nunca comparten caché entre sí.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

/** Verifica firma (RS256 contra el JWKS de Google), `iss`, `aud` y `exp` (todo vía
 *  `jose`); ADEMÁS valida `nonce` (comparación exacta contra el nonce que ESTE
 *  servidor generó, ver arriba) y `email_verified === true` -- ninguna de estas dos
 *  últimas las valida `jose` por sí solo, así que se comprueban explícitamente aquí
 *  ANTES de que el llamador pueda usar el resultado para crear/vincular una sesión. */
export async function verifyGoogleIdToken(
  idToken: string,
  opts: { jwksUrl: string; issuer: string; audience: string; expectedNonce: string },
): Promise<GoogleIdTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, jwksFor(opts.jwksUrl), {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    payload = result.payload;
  } catch (err) {
    throw new GoogleOAuthError("id_token_invalido", `El id_token de Google no es válido: ${err instanceof Error ? err.message : String(err)}`);
  }

  const claims = payload as unknown as GoogleIdTokenClaims;

  if (!claims.nonce || claims.nonce !== opts.expectedNonce) {
    throw new GoogleOAuthError("nonce_invalido", "El nonce del id_token no coincide con el que se solicitó -- posible replay o confusión de sesión.");
  }
  if (claims.email_verified !== true) {
    throw new GoogleOAuthError("correo_no_verificado", "Google no reporta este correo como verificado.");
  }
  if (!claims.email || !claims.sub) {
    throw new GoogleOAuthError("id_token_incompleto", "El id_token de Google no incluye email/sub.");
  }

  return claims;
}

/** Construye la URL de autorización (RFC 6749 §4.1.1 + PKCE §4.3) -- `authBaseUrl` es
 *  inyectable (env `GOOGLE_OAUTH_BASE_URL`, ver arriba). */
export function buildAuthorizationUrl(opts: {
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL("/o/oauth2/v2/auth", opts.authBaseUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  return url.toString();
}
