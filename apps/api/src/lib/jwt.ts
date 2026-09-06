// H2 · ADR-004: JWT propio con `jose` (HS256), exp corta + refresh. Claims mínimos:
// {sub, org_id, hotel_ids, role} — `role` es solo informativo/UX (la autorización real
// se decide en el momento con `hotel_staff` vía RLS + middleware, nunca confiando en un
// claim de rol embebido que podría quedar obsoleto entre el login y la acción).
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

export interface AccessTokenClaims {
  sub: string;
  org_id: string;
  hotel_ids: string[];
  email: string;
  type: "access";
}

export interface RefreshTokenClaims {
  sub: string;
  type: "refresh";
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: Omit<AccessTokenClaims, "type">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(claims.sub)
    .sign(secretKey(secret));
}

export async function signRefreshToken(sub: string, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(sub)
    .sign(secretKey(secret));
}

export class TokenInvalidError extends Error {}
export class TokenExpiredError extends Error {}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "access") throw new TokenInvalidError("El token no es un access token.");
    return payload as unknown as AccessTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError("El token expiró.");
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError("Token inválido.");
  }
}

export async function verifyRefreshToken(token: string, secret: string): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "refresh") throw new TokenInvalidError("El token no es un refresh token.");
    return payload as unknown as RefreshTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError("El refresh token expiró.");
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError("Refresh token inválido.");
  }
}
