// H2 · Middlewares transversales (ADR-004/ADR-008):
//  - requestId: genera/propaga un id por request para logs y el cuerpo de error.
//  - rateLimit: límite por IP siempre, límite adicional por usuario en rutas protegidas.
//  - authMiddleware: valida el JWT (Bearer) y expone {userId, orgId, hotelIds, email}.
//  - dbSession: abre UNA transacción por request contra `atiende_app`/`authenticated`
//    (RLS real) y la comparte con toda la cadena de middlewares/handler restante;
//    confirma al terminar sin error, revierte si algo lanza.
//  - requireHotelMembership: doble capa de autorización (además de RLS) — 403 explícito
//    ANTES de tocar la tabla de negocio cuando el usuario no pertenece al hotel de la
//    ruta o no tiene uno de los roles permitidos.
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { HotelRole } from "./domain/roles.ts";
import { Errors } from "./lib/errors.ts";
import { verifyAccessToken, TokenExpiredError } from "./lib/jwt.ts";
import type { AppDeps, HonoEnvBindings } from "./types.ts";

type Ctx = Context<HonoEnvBindings>;

export function requestId(): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && incoming.length <= 100 ? incoming : randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}

function clientIp(c: Ctx): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
}

export function ipRateLimit(deps: Pick<AppDeps, "ipLimiter">): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    const ip = clientIp(c);
    const result = deps.ipLimiter.check(`ip:${ip}`);
    if (!result.allowed) throw Errors.rateLimited();
    await next();
  };
}

export function userRateLimit(deps: Pick<AppDeps, "userLimiter">): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    const userId = c.get("userId");
    if (userId) {
      const result = deps.userLimiter.check(`user:${userId}`);
      if (!result.allowed) throw Errors.rateLimited();
    }
    await next();
  };
}

export function authMiddleware(env: Pick<AppDeps, "env">["env"]): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw Errors.unauthorized("Falta el header Authorization: Bearer <token>.");
    const token = header.slice("Bearer ".length).trim();

    try {
      const claims = await verifyAccessToken(token, env.jwtSecret);
      c.set("userId", claims.sub);
      c.set("userEmail", claims.email);
      c.set("orgId", claims.org_id);
      c.set("hotelIds", claims.hotel_ids);
    } catch (err) {
      if (err instanceof TokenExpiredError) throw Errors.unauthorized("El token expiró. Inicia sesión de nuevo.");
      throw Errors.unauthorized();
    }

    await next();
  };
}

export function dbSession(engine: AppDeps["engine"]): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    await engine.withAppSession({ userId: c.get("userId") ?? null }, async (session) => {
      c.set("db", session);
      await next();
    });
  };
}

/**
 * 403 explícito (defensa en profundidad, además de la RLS que igual lo bloquearía con
 * 0 filas) cuando el usuario no pertenece a `:hotelIdParam` o no tiene uno de
 * `allowedRoles`. Si el header `X-Hotel-Id` viene presente, debe coincidir con el
 * parámetro de ruta (selector de hotel activo consistente, ADR-004).
 */
export function requireHotelMembership(
  hotelIdParam: string,
  allowedRoles?: HotelRole[],
): MiddlewareHandler<HonoEnvBindings> {
  return async (c: Ctx, next: Next) => {
    const hotelId = c.req.param(hotelIdParam);
    if (!hotelId) throw Errors.validation(`Falta el parámetro de ruta "${hotelIdParam}".`);

    const headerHotelId = c.req.header("x-hotel-id");
    if (headerHotelId && headerHotelId !== hotelId) {
      throw Errors.forbidden("El header X-Hotel-Id no coincide con el hotel de la ruta.");
    }

    const db = c.get("db");
    const { rows } = await db.query<{ role: string; org_id: string }>(
      `select hs.role, hs.org_id
       from public.hotel_staff hs
       where hs.hotel_id = $1 and hs.user_id = auth.uid();`,
      [hotelId],
    );

    if (rows.length === 0) {
      throw Errors.forbidden("No perteneces al staff de este hotel.");
    }
    if (allowedRoles && !allowedRoles.includes(rows[0]!.role as HotelRole)) {
      throw Errors.forbidden(`Tu rol (${rows[0]!.role}) no puede realizar esta acción.`);
    }

    // Autoridad real de org_id/hotelIds para el resto del request: la membresia
    // verificada en este momento, NUNCA el claim potencialmente obsoleto del JWT
    // (ADR-004: el rol/alcance real siempre se resuelve contra hotel_staff en vivo).
    c.set("orgId", rows[0]!.org_id);
    c.set("hotelIds", [hotelId]);
    c.set("hotelRole", rows[0]!.role);
    await next();
  };
}

/**
 * Segunda capa explícita de autorización (además de la RLS, que rechaza igual la
 * escritura): se llama DENTRO de un handler ya protegido por `requireHotelMembership`,
 * para rutas donde el rol permitido depende del método HTTP (ej. cualquier rol de staff
 * puede LEER reservas, pero solo `MANAGE_RESERVATIONS_ROLES` puede crearlas/transicionarlas).
 */
export function assertRole(c: Ctx, allowedRoles: HotelRole[]): void {
  const role = c.get("hotelRole") as HotelRole;
  if (!allowedRoles.includes(role)) {
    throw Errors.forbidden(`Tu rol (${role}) no puede realizar esta acción.`);
  }
}
