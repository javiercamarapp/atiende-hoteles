// H12a · REQ-LAUNCH: alta autoservicio de un hotel nuevo por correo+contraseña.
// `POST /registro` crea org+hotel+owner en una sola transacción (lib/registroHotel.ts)
// y exige verificación de correo antes de poder iniciar sesión -- el owner recién dado
// de alta NO puede hacer `POST /auth/login` hasta confirmar su correo (ver
// `account_token`, migración 0092, y el chequeo explícito abajo).
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword } from "@atiende-hoteles/db";
import { renderVerificacionCuenta, renderBienvenidaHotel } from "@atiende-hoteles/email";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { RateLimiter } from "../lib/rateLimit.ts";
import { crearHotelAutoservicio } from "../lib/registroHotel.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const VERIFICATION_TTL_HOURS = 24;

const registroSchema = z.object({
  hotelName: z.string().trim().min(2, "El nombre del hotel debe tener al menos 2 caracteres.").max(200),
  city: z.string().trim().min(2).max(120),
  stateName: z.string().trim().min(2).max(120),
  ownerFullName: z.string().trim().min(2).max(200),
  ownerEmail: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(10, "La contraseña debe tener al menos 10 caracteres.")
    .max(200)
    .regex(/[A-Za-z]/, "La contraseña debe incluir al menos una letra.")
    .regex(/[0-9]/, "La contraseña debe incluir al menos un número."),
});

const reenviarSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const verificarSchema = z.object({ token: z.string().min(10) });

const ONBOARDING_RATE_HORIZON_DAYS = 30;

const crearTipoHabitacionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  maxOccupancy: z.number().int().min(1).max(20).default(2),
  totalRooms: z.number().int().min(1).max(500),
  basePrice: z.number().min(0),
});

const zonaHorariaSchema = z.object({
  // REQ-LAUNCH: mismo chequeo de forma que la migración 0023 ("Continente/Ciudad" IANA).
  timezone: z.string().trim().regex(/^[A-Za-z_]+\/[A-Za-z_/]+$/, "Debe ser una zona horaria IANA, p. ej. America/Cancun."),
});

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
}

function generarToken(): string {
  return randomBytes(32).toString("hex");
}

async function crearYEnviarVerificacion(
  deps: ResolvedAppDeps,
  data: { orgId: string; hotelId: string; staffUserId: string; email: string; hotelName: string; ownerFullName: string },
): Promise<void> {
  const token = generarToken();
  await deps.engine.admin.query(
    `insert into public.account_token (purpose, org_id, hotel_id, staff_user_id, email, token, expires_at)
     values ('verificar_correo', $1, $2, $3, $4, $5, now() + interval '${VERIFICATION_TTL_HOURS} hours');`,
    [data.orgId, data.hotelId, data.staffUserId, data.email, token],
  );

  const verificationUrl = new URL("/registro/verificar", deps.env.frontendUrl);
  verificationUrl.searchParams.set("token", token);

  const rendered = renderVerificacionCuenta({
    nombreHotel: data.hotelName,
    nombreOwner: data.ownerFullName,
    verificationUrl: verificationUrl.toString(),
    expiraHoras: VERIFICATION_TTL_HOURS,
  });

  await deps.emailPort.send({
    ...rendered,
    to: { email: data.email, name: data.ownerFullName },
    template: "verificacion-cuenta",
    dedupeKey: `verificacion-cuenta:${data.staffUserId}:${token}`,
    tenantId: data.orgId,
    hotelId: data.hotelId,
  });
}

export function registroRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // REQ-LAUNCH: límite de tasa dedicado (más estricto que el general por IP de
  // app.ts): abusar de este endpoint crea filas reales de org/hotel/staff_user, no
  // solo lee datos -- se instancia por-app (no por-request) para que el conteo
  // persista entre llamadas dentro del mismo proceso, igual que ipLimiter/userLimiter.
  const registroLimiter = new RateLimiter({ limit: deps.env.rateLimitRegistroPorIpPorHora, windowMs: 60 * 60 * 1000 });
  const reenvioLimiter = new RateLimiter({ limit: 3, windowMs: 60 * 60 * 1000 });

  app.post("/registro", async (c) => {
    const ip = clientIp(c);
    const limit = registroLimiter.check(`registro:${ip}`);
    if (!limit.allowed) throw Errors.rateLimited((limit.resetAt - Date.now()) / 1000, "Demasiadas altas desde esta red. Intenta de nuevo más tarde.");

    const body = parseBody(registroSchema, await c.req.json().catch(() => ({})));
    const passwordHash = await hashPassword(body.password);

    const created = await crearHotelAutoservicio(deps.engine.admin, {
      hotelName: body.hotelName,
      city: body.city,
      stateName: body.stateName,
      ownerEmail: body.ownerEmail,
      ownerFullName: body.ownerFullName,
      passwordHash,
      createdVia: "registro_autoservicio",
      emailAlreadyVerified: false,
    });

    await crearYEnviarVerificacion(deps, {
      orgId: created.orgId,
      hotelId: created.hotelId,
      staffUserId: created.staffUserId,
      email: body.ownerEmail,
      hotelName: body.hotelName,
      ownerFullName: body.ownerFullName,
    });

    return c.json(
      {
        hotelId: created.hotelId,
        mensaje: "Cuenta creada. Revisa tu correo para confirmar tu cuenta antes de iniciar sesión.",
      },
      201,
    );
  });

  app.post("/registro/reenviar-verificacion", async (c) => {
    const ip = clientIp(c);
    const limit = reenvioLimiter.check(`reenvio:${ip}`);
    if (!limit.allowed) throw Errors.rateLimited((limit.resetAt - Date.now()) / 1000);

    const body = parseBody(reenviarSchema, await c.req.json().catch(() => ({})));

    // Mismo mensaje genérico exista o no la cuenta / ya esté verificada -- nunca se
    // filtra por esta vía si un correo tiene o no cuenta (evita enumeración).
    const generic = { mensaje: "Si existe una cuenta pendiente de verificar con ese correo, te reenviamos el enlace." };

    const { rows } = await deps.engine.admin.query<{
      id: string;
      full_name: string;
      email_verified_at: string | null;
    }>("select id, full_name, email_verified_at from public.staff_user where email = $1;", [body.email]);
    const staff = rows[0];
    if (!staff || staff.email_verified_at) return c.json(generic, 200);

    const { rows: membershipRows } = await deps.engine.admin.query<{ org_id: string; hotel_id: string; hotel_name: string }>(
      `select hs.org_id, hs.hotel_id, l.name as hotel_name
       from public.hotel_staff hs join public.location l on l.id = hs.hotel_id
       where hs.user_id = $1 limit 1;`,
      [staff.id],
    );
    const membership = membershipRows[0];
    if (!membership) return c.json(generic, 200);

    // Invalida cualquier token de verificación pendiente anterior antes de emitir uno
    // nuevo -- nunca deja dos enlaces "vivos" simultáneos para la misma cuenta.
    await deps.engine.admin.query(
      "update public.account_token set status = 'expirado' where purpose = 'verificar_correo' and staff_user_id = $1 and status = 'pendiente';",
      [staff.id],
    );

    await crearYEnviarVerificacion(deps, {
      orgId: membership.org_id,
      hotelId: membership.hotel_id,
      staffUserId: staff.id,
      email: body.email,
      hotelName: membership.hotel_name,
      ownerFullName: staff.full_name,
    });

    return c.json(generic, 200);
  });

  app.post("/registro/verificar", async (c) => {
    const body = parseBody(verificarSchema, await c.req.json().catch(() => ({})));

    // Consumo atómico de un solo uso (mismo patrón que oauth_state/auth-google.ts):
    // solo se marca 'usado' si seguía 'pendiente' y no había vencido.
    const { rows } = await deps.engine.admin.query<{
      id: string;
      staff_user_id: string;
      org_id: string;
      hotel_id: string;
      email: string;
    }>(
      `update public.account_token
       set status = 'usado', used_at = now()
       where token = $1 and purpose = 'verificar_correo' and status = 'pendiente' and expires_at > now()
       returning id, staff_user_id, org_id, hotel_id, email;`,
      [body.token],
    );

    if (rows.length === 0) {
      const { rows: existing } = await deps.engine.admin.query<{ status: string; expires_at: string }>(
        "select status, expires_at from public.account_token where token = $1 and purpose = 'verificar_correo';",
        [body.token],
      );
      if (existing.length === 0) throw Errors.notFound("El enlace de verificación no existe.");
      if (existing[0]!.status === "usado") throw Errors.conflict("Este enlace de verificación ya se usó.");
      throw Errors.conflict("Este enlace de verificación ya venció. Pide que te reenvíen uno nuevo.");
    }

    const consumed = rows[0]!;
    await deps.engine.admin.query("update public.staff_user set email_verified_at = now() where id = $1 and email_verified_at is null;", [
      consumed.staff_user_id,
    ]);

    const { rows: hotelRows } = await deps.engine.admin.query<{ name: string }>("select name from public.location where id = $1;", [
      consumed.hotel_id,
    ]);
    const { rows: staffRows } = await deps.engine.admin.query<{ full_name: string }>("select full_name from public.staff_user where id = $1;", [
      consumed.staff_user_id,
    ]);
    const hotelName = hotelRows[0]?.name ?? "tu hotel";
    const ownerName = staffRows[0]?.full_name ?? "";

    const panelUrl = new URL("/login", deps.env.frontendUrl).toString();
    const rendered = renderBienvenidaHotel({
      nombreHotel: hotelName,
      nombreOwner: ownerName,
      panelUrl,
      pasosOnboarding: [
        "Configura tus tipos de habitación y tarifas base.",
        "Confirma la zona horaria de tu hotel.",
        "Invita a tu equipo con el rol que le corresponde.",
      ],
    });
    await deps.emailPort.send({
      ...rendered,
      to: { email: consumed.email, name: ownerName },
      template: "bienvenida-hotel",
      dedupeKey: `bienvenida-hotel:${consumed.staff_user_id}`,
      tenantId: consumed.org_id,
      hotelId: consumed.hotel_id,
    });

    return c.json({ mensaje: "Correo confirmado. Ya puedes iniciar sesión.", hotelId: consumed.hotel_id }, 200);
  });

  // ---------------------------------------------------------------------------------
  // REQ-LAUNCH: onboarding guiado (apps/web /onboarding) -- solo owner/gm, solo tras
  // haber iniciado sesión (correo ya verificado). Reutiliza EXACTAMENTE el mismo patrón
  // de siembra que packages/db/src/seed.ts (room_type + room + rate_plan/availability a
  // 30 días) para no duplicar dos veces la lógica de "cómo nace el inventario de un
  // hotel", solo que aquí lo dispara el propio dueño desde el panel, no el script de
  // desarrollo.
  // ---------------------------------------------------------------------------------
  app.use("/hoteles/:hotelId/onboarding/*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId", ADMIN_ROLES));

  app.post("/hoteles/:hotelId/onboarding/tipos-habitacion", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearTipoHabitacionSchema, await c.req.json().catch(() => ({})));

    const { rows: rtRows } = await db.query<{ id: string }>(
      "insert into public.room_type (tenant_id, hotel_id, name, max_occupancy) values ($1, $2, $3, $4) returning id;",
      [orgId, hotelId, body.name, body.maxOccupancy],
    );
    const roomTypeId = rtRows[0]!.id;

    for (let i = 1; i <= body.totalRooms; i += 1) {
      const code = `${body.name.slice(0, 3).toUpperCase()}-${i}`;
      await db.query("insert into public.room (tenant_id, hotel_id, room_type_id, code) values ($1, $2, $3, $4);", [
        orgId,
        hotelId,
        roomTypeId,
        code,
      ]);
    }

    for (let day = 0; day < ONBOARDING_RATE_HORIZON_DAYS; day += 1) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + day);
      const isoDate = date.toISOString().slice(0, 10);
      await db.query(
        "insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price) values ($1, $2, $3, $4, $5);",
        [orgId, hotelId, roomTypeId, isoDate, body.basePrice],
      );
      await db.query(
        "insert into public.availability (tenant_id, hotel_id, room_type_id, date, total_rooms) values ($1, $2, $3, $4, $5);",
        [orgId, hotelId, roomTypeId, isoDate, body.totalRooms],
      );
    }

    await db.query("select public.record_audit_log($1, $2, 'room_type.created_onboarding', 'room_type', $3, $4);", [
      orgId,
      hotelId,
      roomTypeId,
      JSON.stringify({ name: body.name, totalRooms: body.totalRooms, basePrice: body.basePrice }),
    ]);

    return c.json({ roomTypeId, name: body.name, totalRooms: body.totalRooms, basePrice: body.basePrice }, 201);
  });

  app.patch("/hoteles/:hotelId/onboarding/zona-horaria", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(zonaHorariaSchema, await c.req.json().catch(() => ({})));

    await db.query("update public.hotel set timezone = $1 where id = $2;", [body.timezone, hotelId]);
    await db.query("select public.record_audit_log($1, $2, 'hotel.timezone_updated', 'hotel', $2, $3);", [
      orgId,
      hotelId,
      JSON.stringify({ timezone: body.timezone }),
    ]);

    return c.json({ timezone: body.timezone }, 200);
  });

  return app;
}
