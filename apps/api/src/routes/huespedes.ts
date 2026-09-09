// H2 · /hoteles/:hotelId/huespedes — contrato apps/web `listarHuespedes()`
// (Huesped[] = {id, nombre, email, estancias}), + GET :id y POST crear.
//
// REQ-HUE-023 (P0/SEG) añade dos superficies nuevas a este archivo:
//
// 1) `/contacto/solicitudes` (+ `/confirmar`): cambiar el teléfono/correo de un
//    huésped ya registrado exige verificar un OTP enviado al CANAL ORIGINAL (el
//    `guest.phone` ya registrado ANTES del cambio) -- nunca al valor nuevo solicitado.
//    Es la ÚNICA vía que puede modificar `guest.email`/`guest.phone` en todo este
//    archivo (el POST de arriba solo los fija UNA VEZ, al crear el huésped) -- no hay
//    ningún otro endpoint que los sobreescriba sin pasar por aquí.
// 2) `/notas`: una nota interna sobre un huésped se rechaza por completo (0 filas
//    insertadas) si `containsDiscriminatoryContent` detecta contenido discriminatorio
//    (packages/domain-hotel/src/conversationalGuardrails.ts) -- fail-closed, nunca se
//    guarda una versión "editada" de la nota rechazada.
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@atiende-hoteles/db";
import {
  containsDiscriminatoryContent,
  evaluateOtpConfirmation,
  generateOtpCode,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { sharedWhatsappAdapter } from "../lib/messaging.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const createGuestSchema = z.object({
  nombre: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
  telefono: z.string().trim().max(40).optional().nullable(),
});

// .strict(): jamás se acepta un campo adicional como "enviarA"/"telefonoDestino" --
// el OTP SIEMPRE se envía al teléfono YA REGISTRADO del huésped (capturado del lado del
// servidor), nunca a un destino que el cuerpo de la petición pudiera intentar imponer
// (REQ-HUE-023: "OTP al canal original").
const solicitarCambioContactoSchema = z
  .object({
    campo: z.enum(["email", "telefono"]),
    valorNuevo: z.string().trim().min(1).max(200),
  })
  .strict();

const confirmarCambioContactoSchema = z.object({ codigo: z.string().trim().length(6) }).strict();

const crearNotaSchema = z.object({ texto: z.string().trim().min(1).max(1000) }).strict();

/** Enmascara el teléfono en la respuesta (nunca se devuelve completo a quien solicita
 *  el cambio, ni el código en sí) -- solo confirma que el envío fue al número YA EN
 *  ARCHIVO, sin exponerlo entero de vuelta. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "*".repeat(phone.length);
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

interface ContactChangeRequestRow {
  id: string;
  guest_id: string;
  field: "email" | "telefono";
  requested_value: string;
  otp_code_hash: string;
  attempts: number;
  max_attempts: number;
  status: "pendiente" | "confirmado" | "rechazado_expirado" | "rechazado_intentos_agotados" | "cancelado";
  expires_at: string;
}

export function huespedesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // RENDIMIENTO: un solo `app.use` (patrón "path*") -- registrar la ruta exacta Y
  // "/huespedes/*" por separado ejecutaba AMBOS middlewares para
  // "/hoteles/:hotelId/huespedes" (Hono hace match de "/huespedes/*" incluso sin
  // segmento adicional), abriendo dos conexiones del pool por request.
  app.use(
    "/hoteles/:hotelId/huespedes*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/huespedes", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ id: string; nombre: string; email: string | null; estancias: string }>(
      `select g.id, g.full_name as nombre, g.email,
              count(r.id)::text as estancias
       from public.guest g
       left join public.reservation r on r.guest_id = g.id
       where g.hotel_id = $1
       group by g.id, g.full_name, g.email
       order by g.full_name asc;`,
      [hotelId],
    );
    return c.json(rows.map((r) => ({ id: r.id, nombre: r.nombre, email: r.email, estancias: Number(r.estancias) })));
  });

  app.get("/hoteles/:hotelId/huespedes/:guestId", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ id: string; nombre: string; email: string | null; telefono: string | null }>(
      `select id, full_name as nombre, email, phone as telefono from public.guest
       where id = $1 and hotel_id = $2;`,
      [c.req.param("guestId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Huésped no encontrado.");
    return c.json(rows[0]);
  });

  app.post("/hoteles/:hotelId/huespedes", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(createGuestSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string }>(
      `insert into public.guest (tenant_id, hotel_id, full_name, email, phone)
       values ($1, $2, $3, $4, $5)
       returning id;`,
      [orgId, hotelId, body.nombre, body.email ?? null, body.telefono ?? null],
    );

    return c.json({ id: rows[0]!.id, nombre: body.nombre, email: body.email ?? null }, 201);
  });

  // REQ-HUE-023: paso 1/2 -- solicita el cambio de `email`/`telefono` de un huésped ya
  // registrado. Genera un OTP, guarda solo su HASH (nunca el código en texto plano) y
  // lo envía SIEMPRE al `guest.phone` YA REGISTRADO (canal original) -- jamás al
  // `valorNuevo` solicitado, sin importar si `campo` es "telefono" o "email".
  app.post("/hoteles/:hotelId/huespedes/:guestId/contacto/solicitudes", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const body = parseBody(solicitarCambioContactoSchema, await c.req.json().catch(() => ({})));

    const { rows: guestRows } = await db.query<{ id: string; phone: string | null }>(
      "select id, phone from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (!guestRows[0]) throw Errors.notFound("Huésped no encontrado.");
    const canalOriginal = guestRows[0].phone;
    if (!canalOriginal) {
      // Fail-closed (REQ-HUE-023): sin un teléfono YA registrado no existe ningún canal
      // original contra el cual verificar -- nunca se acepta verificar contra el propio
      // valor nuevo solicitado ni contra ningún otro dato del cuerpo de la petición.
      throw Errors.conflict(
        "Este huésped no tiene un teléfono registrado; no hay un canal original al cual enviar el OTP de verificación.",
      );
    }

    const codigo = generateOtpCode();
    const codeHash = await hashPassword(codigo);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

    const { rows: reqRows } = await db.query<{ id: string }>(
      `insert into public.guest_contact_change_request
         (tenant_id, hotel_id, guest_id, field, requested_value, otp_sent_to_phone,
          otp_code_hash, max_attempts, expires_at, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id;`,
      [c.get("orgId"), hotelId, guestId, body.campo, body.valorNuevo, canalOriginal, codeHash, OTP_MAX_ATTEMPTS, expiresAt, c.get("userId")],
    );
    const requestId = reqRows[0]!.id;

    await sharedWhatsappAdapter.sendTemplateMessage({
      to: canalOriginal,
      templateName: "verificacion_cambio_contacto",
      languageCode: "es_MX",
      parameters: [codigo],
      clientMessageId: `otp-contacto-${requestId}`,
    });

    return c.json(
      {
        requestId,
        campo: body.campo,
        canalEnvio: "whatsapp",
        enviadoA: maskPhone(canalOriginal),
        expiraEn: expiresAt.toISOString(),
      },
      201,
    );
  });

  // REQ-HUE-023: paso 2/2 -- confirma el OTP enviado en el paso anterior. Solo aplica
  // el cambio real de `guest.email`/`guest.phone` cuando `evaluateOtpConfirmation`
  // (packages/domain-hotel/src/guestContactChangeOtp.ts) devuelve `applyChange: true`
  // -- código correcto, no expirado, no ya-confirmado/cancelado, intentos disponibles.
  app.post("/hoteles/:hotelId/huespedes/:guestId/contacto/solicitudes/:requestId/confirmar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const requestId = c.req.param("requestId");
    const body = parseBody(confirmarCambioContactoSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<ContactChangeRequestRow>(
      `select id, guest_id, field::text as field, requested_value, otp_code_hash, attempts, max_attempts,
              status::text as status, expires_at::text as expires_at
       from public.guest_contact_change_request
       where id = $1 and hotel_id = $2 and guest_id = $3;`,
      [requestId, hotelId, guestId],
    );
    if (!rows[0]) throw Errors.notFound("Solicitud de cambio de contacto no encontrada.");
    const solicitud = rows[0];

    const codeMatches = await verifyPassword(body.codigo, solicitud.otp_code_hash);
    const decision = evaluateOtpConfirmation({
      status: solicitud.status,
      expiresAt: new Date(solicitud.expires_at),
      now: new Date(),
      attemptsBefore: solicitud.attempts,
      maxAttempts: solicitud.max_attempts,
      codeMatches,
    });

    if (decision.applyChange) {
      const column = solicitud.field === "email" ? "email" : "phone";
      await db.query(
        `update public.guest_contact_change_request
         set status = $1, attempts = $2, confirmed_at = now(), updated_at = now()
         where id = $3;`,
        [decision.nextStatus, decision.attemptsAfter, requestId],
      );
      // Columna resuelta desde un enum cerrado de 2 valores ($1 arriba nunca es texto
      // libre del body) -- no hay inyección SQL posible por interpolar `column` aquí.
      await db.query(`update public.guest set ${column} = $1, updated_at = now() where id = $2;`, [
        solicitud.requested_value,
        guestId,
      ]);
      return c.json({ estado: "confirmado", campo: solicitud.field });
    }

    await db.query(
      `update public.guest_contact_change_request set status = $1, attempts = $2, updated_at = now() where id = $3;`,
      [decision.nextStatus, decision.attemptsAfter, requestId],
    );

    if (decision.outcome === "rechazado_codigo_incorrecto") {
      throw Errors.conflict(
        `Código incorrecto. Intentos restantes: ${Math.max(0, solicitud.max_attempts - decision.attemptsAfter)}.`,
      );
    }
    if (decision.outcome === "rechazado_expirado") throw Errors.conflict("Este código de verificación ya expiró.");
    if (decision.outcome === "rechazado_intentos_agotados") {
      throw Errors.conflict("Se agotaron los intentos de verificación para esta solicitud; hay que solicitar un nuevo cambio de contacto.");
    }
    throw Errors.conflict("Esta solicitud ya fue confirmada o cancelada anteriormente.");
  });

  // REQ-HUE-023: "0 notas discriminatorias generadas" -- se evalúa ANTES de insertar;
  // una nota que hace match con `containsDiscriminatoryContent` se rechaza por completo
  // (0 filas insertadas), nunca se guarda una versión "editada".
  app.post("/hoteles/:hotelId/huespedes/:guestId/notas", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const body = parseBody(crearNotaSchema, await c.req.json().catch(() => ({})));

    const rechazo = containsDiscriminatoryContent(body.texto);
    if (rechazo) {
      throw Errors.validation(rechazo.refusalMessage);
    }

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (!guestRows[0]) throw Errors.notFound("Huésped no encontrado.");

    const { rows } = await db.query<{ id: string; created_at: string }>(
      `insert into public.guest_note (tenant_id, hotel_id, guest_id, body, created_by)
       values ($1, $2, $3, $4, $5)
       returning id, created_at::text as created_at;`,
      [c.get("orgId"), hotelId, guestId, body.texto, c.get("userId")],
    );
    return c.json({ id: rows[0]!.id, texto: body.texto, creadoEn: rows[0]!.created_at }, 201);
  });

  app.get("/hoteles/:hotelId/huespedes/:guestId/notas", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<{ id: string; body: string; created_at: string }>(
      `select id, body, created_at::text as created_at from public.guest_note
       where guest_id = $1 and hotel_id = $2 order by created_at desc;`,
      [c.req.param("guestId"), c.req.param("hotelId")],
    );
    return c.json(rows.map((r) => ({ id: r.id, texto: r.body, creadoEn: r.created_at })));
  });

  return app;
}
