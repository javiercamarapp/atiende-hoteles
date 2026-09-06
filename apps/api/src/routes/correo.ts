// H12a · REQ-LAUNCH: operaciones de cuenta que se completan por correo y NO caben en
// `registro.ts` (alta inicial) ni `auth-google.ts` (OAuth): invitar staff con rol,
// aceptar invitación, "olvidé mi contraseña", cambio de correo. Todas usan
// `account_token` (migración 0092, un solo uso real) + `packages/email`.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword } from "@atiende-hoteles/db";
import {
  renderInvitacionStaff,
  renderRestablecerContrasena,
  renderCambioCorreo,
} from "@atiende-hoteles/email";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { RateLimiter } from "../lib/rateLimit.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { HOTEL_ROLES, ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const ROLE_LABELS: Record<HotelRole, string> = {
  owner: "Propietario",
  gm: "Gerente general",
  frontdesk: "Recepción",
  reservations: "Reservas",
  housekeeping: "Ama de llaves",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};

const INVITATION_TTL_DAYS = 7;
const PASSWORD_RESET_TTL_HOURS = 1;
const EMAIL_CHANGE_TTL_HOURS = 24;

function generarToken(): string {
  return randomBytes(32).toString("hex");
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
}

const invitarSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(HOTEL_ROLES),
});

const aceptarInvitacionSchema = z.object({
  token: z.string().min(10),
  // Solo requerido si la persona invitada TODAVÍA no tiene cuenta (staff_user nuevo).
  fullName: z.string().trim().min(2).max(200).optional(),
  password: z.string().min(10).max(200).optional(),
});

const olvidePasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const restablecerSchema = z.object({
  token: z.string().min(10),
  newPassword: z
    .string()
    .min(10, "La contraseña debe tener al menos 10 caracteres.")
    .max(200)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});

const cambiarCorreoSchema = z.object({ newEmail: z.string().trim().toLowerCase().email() });
const confirmarCambioCorreoSchema = z.object({ token: z.string().min(10) });

export function correoRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  const olvideLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

  // ---------------------------------------------------------------------------------
  // Invitaciones de staff (owner/gm autenticados, REQ-UX-006 estilo).
  // ---------------------------------------------------------------------------------
  app.use("/hoteles/:hotelId/staff/invitaciones", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId", ADMIN_ROLES));
  app.use(
    "/hoteles/:hotelId/staff/invitaciones/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId", ADMIN_ROLES),
  );

  app.post("/hoteles/:hotelId/staff/invitaciones", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(invitarSchema, await c.req.json().catch(() => ({})));

    const { rows: hotelRows } = await db.query<{ name: string }>("select name from public.location where id = $1;", [hotelId]);
    const hotelName = hotelRows[0]?.name ?? "tu hotel";
    const inviterEmail = c.get("userEmail");

    // Invalida cualquier invitación PENDIENTE anterior a este correo para este hotel
    // (el índice único parcial de la migración 0092 lo exigiría de todos modos, pero
    // se hace explícito para dar un mensaje claro en vez del error crudo de índice).
    await db.query(
      "update public.account_token set status = 'expirado' where hotel_id = $1 and purpose = 'invitacion_staff' and lower(email) = $2 and status = 'pendiente';",
      [hotelId, body.email],
    );

    const token = generarToken();
    await db.query(
      `insert into public.account_token (purpose, org_id, hotel_id, email, role, token, expires_at)
       values ('invitacion_staff', $1, $2, $3, $4, $5, now() + interval '${INVITATION_TTL_DAYS} days');`,
      [orgId, hotelId, body.email, body.role, token],
    );

    const invitationUrl = new URL("/registro/invitacion", deps.env.frontendUrl);
    invitationUrl.searchParams.set("token", token);

    const rendered = renderInvitacionStaff({
      nombreHotel: hotelName,
      nombreQuienInvita: inviterEmail,
      rolAsignado: ROLE_LABELS[body.role],
      invitationUrl: invitationUrl.toString(),
      expiraDias: INVITATION_TTL_DAYS,
    });
    await deps.emailPort.send({
      ...rendered,
      to: { email: body.email },
      template: "invitacion-staff",
      dedupeKey: `invitacion-staff:${hotelId}:${body.email}:${token}`,
      tenantId: orgId,
      hotelId,
    });

    return c.json({ mensaje: "Invitación enviada.", email: body.email, role: body.role }, 201);
  });

  app.get("/hoteles/:hotelId/staff/invitaciones", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ id: string; email: string; role: HotelRole; status: string; expires_at: string; created_at: string }>(
      `select id, email, role, status, expires_at, created_at
       from public.account_token
       where hotel_id = $1 and purpose = 'invitacion_staff'
       order by created_at desc;`,
      [hotelId],
    );
    return c.json(
      rows.map((r) => ({ id: r.id, email: r.email, rol: r.role, estado: r.status, expiraEn: r.expires_at, creadoEn: r.created_at })),
      200,
    );
  });

  app.delete("/hoteles/:hotelId/staff/invitaciones/:tokenId", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const tokenId = c.req.param("tokenId");
    const { rows } = await db.query<{ id: string }>(
      "update public.account_token set status = 'expirado' where id = $1 and hotel_id = $2 and purpose = 'invitacion_staff' and status = 'pendiente' returning id;",
      [tokenId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("La invitación no existe o ya no está pendiente.");
    return c.json({ mensaje: "Invitación revocada." }, 200);
  });

  // Aceptar invitación: SIN sesión (quien invitan puede no tener cuenta todavía) --
  // usa el cliente admin, mismo criterio que registro.ts/auth-google.ts.
  app.post("/registro/invitacion/aceptar", async (c) => {
    const body = parseBody(aceptarInvitacionSchema, await c.req.json().catch(() => ({})));

    const { rows } = await deps.engine.admin.query<{
      id: string;
      org_id: string;
      hotel_id: string;
      email: string;
      role: HotelRole;
    }>(
      `update public.account_token
       set status = 'usado', used_at = now()
       where token = $1 and purpose = 'invitacion_staff' and status = 'pendiente' and expires_at > now()
       returning id, org_id, hotel_id, email, role;`,
      [body.token],
    );

    if (rows.length === 0) {
      const { rows: existing } = await deps.engine.admin.query<{ status: string }>(
        "select status from public.account_token where token = $1 and purpose = 'invitacion_staff';",
        [body.token],
      );
      if (existing.length === 0) throw Errors.notFound("La invitación no existe.");
      if (existing[0]!.status === "usado") throw Errors.conflict("Esta invitación ya se usó.");
      throw Errors.conflict("Esta invitación ya venció. Pide que te envíen una nueva.");
    }

    const invite = rows[0]!;

    const { rows: existingStaff } = await deps.engine.admin.query<{ id: string; password_hash: string | null }>(
      "select id, password_hash from public.staff_user where email = $1;",
      [invite.email],
    );

    let staffUserId: string;
    if (existingStaff.length > 0) {
      staffUserId = existingStaff[0]!.id;
    } else {
      if (!body.fullName || !body.password) {
        throw Errors.validation("Se requieren fullName y password para crear tu cuenta al aceptar la invitación.");
      }
      const passwordHash = await hashPassword(body.password);
      const { rows: created } = await deps.engine.admin.query<{ id: string }>(
        `insert into public.staff_user (email, full_name, password_hash, created_via, email_verified_at)
         values ($1, $2, $3, 'invitacion', now())
         returning id;`,
        [invite.email, body.fullName, passwordHash],
      );
      staffUserId = created[0]!.id;
    }

    await deps.engine.admin.query(
      `insert into public.hotel_staff (org_id, hotel_id, user_id, role)
       values ($1, $2, $3, $4)
       on conflict (hotel_id, user_id) do update set role = excluded.role;`,
      [invite.org_id, invite.hotel_id, staffUserId, invite.role],
    );

    return c.json({ mensaje: "Invitación aceptada. Ya puedes iniciar sesión.", hotelId: invite.hotel_id }, 200);
  });

  // ---------------------------------------------------------------------------------
  // "Olvidé mi contraseña".
  // ---------------------------------------------------------------------------------
  app.post("/auth/olvide-password", async (c) => {
    const ip = clientIp(c);
    const limit = olvideLimiter.check(`olvide:${ip}`);
    if (!limit.allowed) throw Errors.rateLimited((limit.resetAt - Date.now()) / 1000);

    const body = parseBody(olvidePasswordSchema, await c.req.json().catch(() => ({})));
    // Mismo mensaje siempre exista o no la cuenta -- evita enumeración de correos.
    const generic = { mensaje: "Si existe una cuenta con ese correo, te enviamos instrucciones para restablecer tu contraseña." };

    const { rows } = await deps.engine.admin.query<{ id: string }>("select id from public.staff_user where email = $1;", [body.email]);
    const staff = rows[0];
    if (!staff) return c.json(generic, 200);

    await deps.engine.admin.query(
      "update public.account_token set status = 'expirado' where staff_user_id = $1 and purpose = 'restablecer_contrasena' and status = 'pendiente';",
      [staff.id],
    );

    const token = generarToken();
    await deps.engine.admin.query(
      `insert into public.account_token (purpose, staff_user_id, email, token, expires_at)
       values ('restablecer_contrasena', $1, $2, $3, now() + interval '${PASSWORD_RESET_TTL_HOURS} hours');`,
      [staff.id, body.email, token],
    );

    const resetUrl = new URL("/restablecer-password", deps.env.frontendUrl);
    resetUrl.searchParams.set("token", token);
    const rendered = renderRestablecerContrasena({ email: body.email, resetUrl: resetUrl.toString(), expiraHoras: PASSWORD_RESET_TTL_HOURS });
    await deps.emailPort.send({
      ...rendered,
      to: { email: body.email },
      template: "restablecer-contrasena",
      dedupeKey: `restablecer-contrasena:${staff.id}:${token}`,
    });

    return c.json(generic, 200);
  });

  app.post("/auth/restablecer-password", async (c) => {
    const body = parseBody(restablecerSchema, await c.req.json().catch(() => ({})));

    const { rows } = await deps.engine.admin.query<{ staff_user_id: string }>(
      `update public.account_token
       set status = 'usado', used_at = now()
       where token = $1 and purpose = 'restablecer_contrasena' and status = 'pendiente' and expires_at > now()
       returning staff_user_id;`,
      [body.token],
    );
    if (rows.length === 0) throw Errors.conflict("El enlace para restablecer tu contraseña no es válido o ya venció.");

    const passwordHash = await hashPassword(body.newPassword);
    await deps.engine.admin.query("update public.staff_user set password_hash = $1 where id = $2;", [passwordHash, rows[0]!.staff_user_id]);

    return c.json({ mensaje: "Contraseña actualizada. Ya puedes iniciar sesión con tu nueva contraseña." }, 200);
  });

  // ---------------------------------------------------------------------------------
  // Cambio de correo (requiere sesión para SOLICITARLO; confirmarlo es por token).
  // ---------------------------------------------------------------------------------
  app.use("/auth/me/cambiar-correo", authMiddleware(deps.env), dbSession(deps.engine));
  app.post("/auth/me/cambiar-correo", async (c) => {
    const userId = c.get("userId");
    const currentEmail = c.get("userEmail");
    const body = parseBody(cambiarCorreoSchema, await c.req.json().catch(() => ({})));

    const { rows: taken } = await deps.engine.admin.query<{ id: string }>("select id from public.staff_user where email = $1;", [body.newEmail]);
    if (taken.length > 0) throw Errors.conflict("Ese correo ya está en uso por otra cuenta.");

    await deps.engine.admin.query(
      "update public.account_token set status = 'expirado' where staff_user_id = $1 and purpose = 'cambio_correo' and status = 'pendiente';",
      [userId],
    );

    const token = generarToken();
    await deps.engine.admin.query(
      `insert into public.account_token (purpose, staff_user_id, email, token, expires_at)
       values ('cambio_correo', $1, $2, $3, now() + interval '${EMAIL_CHANGE_TTL_HOURS} hours');`,
      [userId, body.newEmail, token],
    );

    const confirmUrl = new URL("/confirmar-cambio-correo", deps.env.frontendUrl);
    confirmUrl.searchParams.set("token", token);
    const rendered = renderCambioCorreo({
      correoAnterior: currentEmail,
      correoNuevo: body.newEmail,
      confirmUrl: confirmUrl.toString(),
      expiraHoras: EMAIL_CHANGE_TTL_HOURS,
    });
    await deps.emailPort.send({ ...rendered, to: { email: body.newEmail }, template: "cambio-correo", dedupeKey: `cambio-correo:${userId}:${token}` });

    return c.json({ mensaje: "Te enviamos un correo de confirmación a tu nueva dirección." }, 200);
  });

  app.post("/auth/cambiar-correo/confirmar", async (c) => {
    const body = parseBody(confirmarCambioCorreoSchema, await c.req.json().catch(() => ({})));

    const { rows } = await deps.engine.admin.query<{ staff_user_id: string; email: string }>(
      `update public.account_token
       set status = 'usado', used_at = now()
       where token = $1 and purpose = 'cambio_correo' and status = 'pendiente' and expires_at > now()
       returning staff_user_id, email;`,
      [body.token],
    );
    if (rows.length === 0) throw Errors.conflict("El enlace para confirmar tu nuevo correo no es válido o ya venció.");

    const { staff_user_id: staffUserId, email: newEmail } = rows[0]!;
    try {
      await deps.engine.admin.query("update public.staff_user set email = $1 where id = $2;", [newEmail, staffUserId]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(message)) throw Errors.conflict("Ese correo ya está en uso por otra cuenta.");
      throw err;
    }

    return c.json({ mensaje: "Tu correo se actualizó correctamente." }, 200);
  });

  return app;
}
