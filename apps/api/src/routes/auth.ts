// H2 · ADR-004: login por email/contraseña contra `staff_user` (hash scrypt,
// packages/db/src/password.ts), JWT propio (`jose`, HS256, exp corta + refresh).
//
// El lookup de login usa el cliente ADMIN (bypassa RLS) porque, antes de autenticar, no
// existe todavía un `auth.uid()` que las políticas de `staff_user`/`hotel_staff` puedan
// evaluar — mismo rol que cumple el "service role" de GoTrue en Supabase real (ADR-003:
// "brecha declarada", nunca se usa el admin client para servir datos de negocio ya
// autenticados, solo para esta resolución de credenciales pre-sesión).
import { Hono } from "hono";
import { z } from "zod";
import { verifyPassword } from "@atiende-hoteles/db";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/jwt.ts";
import { authMiddleware, dbSession } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// REQ-UX-006: número de WhatsApp del propio staff, usado para resolver el actor de
// una aprobación decidida por botón de WhatsApp (routes/aprobacionesWhatsapp.ts).
const whatsappSchema = z.object({
  whatsappPhone: z.string().trim().regex(/^\+[0-9]{8,15}$/, "formato E.164 esperado, p. ej. +5219981234567"),
});

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
}

interface MembershipRow {
  org_id: string;
  hotel_id: string;
  role: string;
  hotel_name: string;
}

async function issueSession(deps: AppDeps, staff: StaffRow) {
  const { rows: memberships } = await deps.engine.admin.query<MembershipRow>(
    `select hs.org_id, hs.hotel_id, hs.role, l.name as hotel_name
     from public.hotel_staff hs
     join public.location l on l.id = hs.hotel_id
     where hs.user_id = $1
     order by l.name asc;`,
    [staff.id],
  );

  const orgId = memberships[0]?.org_id ?? "";
  const hotelIds = memberships.map((m) => m.hotel_id);
  const role = memberships[0]?.role ?? null;

  const token = await signAccessToken(
    { sub: staff.id, org_id: orgId, hotel_ids: hotelIds, email: staff.email },
    deps.env.jwtSecret,
    deps.env.accessTokenTtlSeconds,
  );
  const refreshToken = await signRefreshToken(staff.id, deps.env.jwtSecret, deps.env.refreshTokenTtlSeconds);

  return {
    token,
    refreshToken,
    email: staff.email,
    rol: role ?? "sin_rol",
    hoteles: memberships.map((m) => ({ id: m.hotel_id, nombre: m.hotel_name, rol: m.role })),
  };
}

export function authRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.post("/auth/login", async (c) => {
    const body = parseBody(loginSchema, await c.req.json().catch(() => ({})));

    const { rows } = await deps.engine.admin.query<StaffRow>(
      "select id, email, full_name, password_hash from public.staff_user where email = $1;",
      [body.email],
    );
    const staff = rows[0];

    // Mismo mensaje genérico exista o no el correo (no filtrar qué parte fue incorrecta).
    const invalidCredentials = () => Errors.unauthorized("Correo o contraseña incorrectos.");

    if (!staff) throw invalidCredentials();
    const valid = await verifyPassword(body.password, staff.password_hash);
    if (!valid) throw invalidCredentials();

    const session = await issueSession(deps, staff);
    return c.json(session, 200);
  });

  app.post("/auth/refresh", async (c) => {
    const body = parseBody(refreshSchema, await c.req.json().catch(() => ({})));
    let sub: string;
    try {
      const claims = await verifyRefreshToken(body.refreshToken, deps.env.jwtSecret);
      sub = claims.sub;
    } catch {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    const { rows } = await deps.engine.admin.query<StaffRow>(
      "select id, email, full_name, password_hash from public.staff_user where id = $1;",
      [sub],
    );
    const staff = rows[0];
    if (!staff) throw Errors.unauthorized();

    const session = await issueSession(deps, staff);
    return c.json(session, 200);
  });

  app.use("/auth/me", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/auth/me", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<MembershipRow>(
      `select hs.org_id, hs.hotel_id, hs.role, l.name as hotel_name
       from public.hotel_staff hs
       join public.location l on l.id = hs.hotel_id
       where hs.user_id = auth.uid()
       order by l.name asc;`,
    );

    return c.json({
      id: c.get("userId"),
      email: c.get("userEmail"),
      orgId: rows[0]?.org_id ?? null,
      hoteles: rows.map((m) => ({ id: m.hotel_id, nombre: m.hotel_name, rol: m.role })),
    });
  });

  // REQ-UX-006: autoservicio -- cada staff registra SU PROPIO número de WhatsApp
  // (nunca el de otro: RLS + GRANT acotado a esta columna, migración 0053).
  app.use("/auth/me/whatsapp", authMiddleware(deps.env), dbSession(deps.engine));
  app.patch("/auth/me/whatsapp", async (c) => {
    const db = c.get("db");
    const body = parseBody(whatsappSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await db.query<{ id: string }>(
        "update public.staff_user set whatsapp_phone = $1 where id = auth.uid() returning id;",
        [body.whatsappPhone],
      );
      if (rows.length === 0) throw Errors.notFound("Cuenta de staff no encontrada.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(message)) throw Errors.conflict("Ese número de WhatsApp ya está registrado a otra cuenta.");
      throw err;
    }

    return c.json({ whatsappPhone: body.whatsappPhone });
  });

  return app;
}
