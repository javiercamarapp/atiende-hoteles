// auditoria-2/legal [ALTO] "No hay ningún camino operable para ejercer derechos ARCO":
// endpoints mínimos para que un huésped pueda (a) exportar sus propios datos vía un
// enlace de un solo uso (mismo patrón que checkin_link/checkinOnline.ts) y (b) crear un
// ticket auditado de rectificación/cancelación/oposición con SLA
// (packages/db/migrations/0068_consentimiento_y_arco.sql). Resolución real del ticket
// (contactar al huésped, ejecutar el borrado/rectificación) sigue siendo un proceso
// HUMANO del hotel -- lo que esto garantiza es que exista un registro auditable con
// plazo, que es lo que REQ-SEG-002 exige y hoy no existía en absoluto.
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const EXPORT_LINK_TTL_HOURS = 24;

const solicitudSchema = z.object({
  hotelId: z.string().uuid(),
  tipo: z.enum(["acceso", "rectificacion", "cancelacion", "oposicion"]),
  contacto: z.string().trim().min(3).max(300),
  detalle: z.string().trim().max(2000).optional(),
});

const resolverSchema = z.object({
  status: z.enum(["en_proceso", "resuelta", "rechazada"]),
  notaResolucion: z.string().trim().max(2000).optional(),
});

interface PrivacyRequestRow {
  id: string;
  tipo: string;
  contacto: string;
  detalle: string | null;
  status: string;
  sla_due_at: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

function toSolicitudBody(row: PrivacyRequestRow) {
  return {
    id: row.id,
    tipo: row.tipo,
    contacto: row.contacto,
    detalle: row.detalle,
    estado: row.status,
    slaVenceEn: row.sla_due_at,
    creadoEn: row.created_at,
    resueltoEn: row.resolved_at,
    notaResolucion: row.resolution_note,
  };
}

export function privacidadRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // --- Exportación de datos (REQ-SEG-002, derecho de acceso) -------------------
  app.use(
    "/hoteles/:hotelId/huespedes/:guestId/exportar-datos",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // El staff emite el enlace (p. ej. tras verificar la identidad del huésped por
  // teléfono/en persona) -- el huésped nunca necesita una cuenta para ejercer su
  // derecho de acceso. `guestId` está scoped a `hotelId` en la query (mismo criterio
  // que huespedes.ts) y la FK compuesta de `guest_data_export_link` (migración 0068)
  // hace estructuralmente imposible emitir un enlace para un guest de otro hotel.
  app.post("/hoteles/:hotelId/huespedes/:guestId/exportar-datos", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    const token = randomBytes(32).toString("hex");
    const { rows } = await db.query<{ id: string; token: string; expires_at: string }>(
      `insert into public.guest_data_export_link (tenant_id, hotel_id, guest_id, token, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
       returning id, token, expires_at::text as expires_at;`,
      [orgId, hotelId, guestId, token, String(EXPORT_LINK_TTL_HOURS)],
    );

    return c.json(
      { id: rows[0]!.id, token: rows[0]!.token, expiraEn: rows[0]!.expires_at, ruta: `/privacidad/mis-datos/${rows[0]!.token}` },
      201,
    );
  });

  // Público, sin sesión (el huésped autentica con el token de un solo uso).
  app.get("/privacidad/mis-datos/:token", async (c) => {
    const token = c.req.param("token");
    try {
      const { rows } = await deps.engine.admin.query<{ export_guest_data_public: unknown }>(
        "select public.export_guest_data_public($1) as export_guest_data_public;",
        [token],
      );
      return c.json(rows[0]!.export_guest_data_public as object);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/export_link_no_encontrado/.test(message)) throw Errors.notFound("Enlace de exportación no encontrado.");
      if (/export_link_ya_usado/.test(message)) throw Errors.conflict("Este enlace de exportación ya fue utilizado.");
      if (/export_link_expirado/.test(message)) throw Errors.conflict("Este enlace de exportación ya venció.");
      throw err;
    }
  });

  // --- Ticket ARCO (rectificación/cancelación/oposición, con SLA) ---------------
  // Público, sin sesión: quien solicita normalmente no tiene cuenta en el panel. El
  // `hotelId` viene del propio flujo (p. ej. el aviso de privacidad del hotel que se le
  // envió al huésped), no es información sensible por sí sola.
  app.post("/privacidad/solicitud", async (c) => {
    const body = parseBody(solicitudSchema, await c.req.json().catch(() => ({})));
    try {
      const { rows } = await deps.engine.admin.query<PrivacyRequestRow>(
        "select * from public.create_privacy_request($1, $2, $3, $4);",
        [body.hotelId, body.tipo, body.contacto, body.detalle ?? null],
      );
      return c.json(toSolicitudBody(rows[0]!), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/hotel_no_encontrado/.test(message)) throw Errors.notFound("Hotel no encontrado.");
      if (/contacto_requerido/.test(message)) throw Errors.validation("Se requiere un correo o teléfono de contacto.");
      throw err;
    }
  });

  app.use(
    "/hoteles/:hotelId/privacidad/solicitudes*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/privacidad/solicitudes", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<PrivacyRequestRow>(
      `select id, tipo, contacto, detalle, status, sla_due_at::text as sla_due_at, created_at::text as created_at,
              resolved_at::text as resolved_at, resolution_note
       from public.privacy_request where hotel_id = $1 order by created_at desc;`,
      [hotelId],
    );
    return c.json(rows.map(toSolicitudBody));
  });

  app.patch("/hoteles/:hotelId/privacidad/solicitudes/:id", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const id = c.req.param("id");
    const body = parseBody(resolverSchema, await c.req.json().catch(() => ({})));

    const resolvedAtClause = body.status === "resuelta" || body.status === "rechazada" ? "now()" : "null";
    const { rows } = await db.query<PrivacyRequestRow>(
      `update public.privacy_request
       set status = $1, resolution_note = coalesce($2, resolution_note), resolved_at = ${resolvedAtClause}
       where id = $3 and hotel_id = $4
       returning id, tipo, contacto, detalle, status, sla_due_at::text as sla_due_at, created_at::text as created_at,
                 resolved_at::text as resolved_at, resolution_note;`,
      [body.status, body.notaResolucion ?? null, id, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Solicitud ARCO no encontrada.");

    await db.query("select public.record_audit_log($1, $2, 'privacy_request.updated', 'privacy_request', $3, $4);", [
      orgId,
      hotelId,
      id,
      JSON.stringify({ status: body.status }),
    ]);

    return c.json(toSolicitudBody(rows[0]!));
  });

  return app;
}
