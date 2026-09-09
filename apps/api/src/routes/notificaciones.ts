// H12c · LAUNCH-017: centro de notificaciones in-app. La emisión real de eventos vive en
// triggers de base de datos (packages/db/migrations/0114) -- esta ruta es de LECTURA/
// gestión (listar, contar no leídas, marcar leídas), nunca genera notificaciones ella
// misma salvo el endpoint explícito de preferencias. RLS (0113) ya filtra cada SELECT a
// lo que el usuario autenticado puede ver -- estas queries nunca añaden `WHERE
// recipient_user_id = ...` por su cuenta (sería redundante y, peor, daría una falsa
// sensación de que el filtrado ocurre en la aplicación en vez de en la base).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

interface NotificationRow {
  id: string;
  hotel_id: string | null;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function notificationBody(row: NotificationRow) {
  return {
    id: row.id,
    hotelId: row.hotel_id,
    tipo: row.type,
    titulo: row.title,
    cuerpo: row.body,
    enlace: row.link,
    leidaEn: row.read_at,
    creadaEn: row.created_at,
  };
}

const preferenceSchema = z.object({
  type: z.enum(["reserva_nueva", "aprobacion_pendiente", "ticket_urgente", "night_audit_cerrado", "limite_plan", "sistema"]),
  enabled: z.boolean(),
});

export function notificacionesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/notificaciones*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.use("/notificaciones/preferencias", authMiddleware(deps.env), dbSession(deps.engine));

  app.get("/hoteles/:hotelId/notificaciones", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const soloNoLeidas = c.req.query("no_leidas") === "true";
    const { rows } = await db.query<NotificationRow>(
      `select id, hotel_id, type, title, body, link, read_at::text, created_at::text
       from public.notification
       where tenant_id = $1 and (hotel_id = $2 or hotel_id is null) ${soloNoLeidas ? "and read_at is null" : ""}
       order by created_at desc
       limit 100;`,
      [orgId, hotelId],
    );
    return c.json(rows.map(notificationBody));
  });

  app.get("/hoteles/:hotelId/notificaciones/no-leidas/conteo", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ conteo: string }>(
      `select count(*)::text as conteo
       from public.notification
       where tenant_id = $1 and (hotel_id = $2 or hotel_id is null) and read_at is null;`,
      [orgId, hotelId],
    );
    return c.json({ conteo: Number(rows[0]?.conteo ?? 0) });
  });

  app.patch("/hoteles/:hotelId/notificaciones/:id/leer", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const { rows } = await db.query<{ id: string }>(
      "update public.notification set read_at = now() where id = $1 and read_at is null returning id;",
      [id],
    );
    if (rows.length === 0) {
      // 0 filas: o no existe, o ya estaba leída, o RLS la rechazó (no es el destinatario)
      // -- respuesta uniforme (nunca se revela cuál de los tres pasó, mismo criterio de
      // no filtrar existencia que el resto del API).
      throw Errors.notFound("Notificación no encontrada.");
    }
    return c.json({ ok: true });
  });

  // "Marcar todo como leído" ATÓMICO -- una sola sentencia SQL (mark_all_notifications_read,
  // 0113), no un SELECT de ids seguido de N UPDATEs desde apps/api (esa carrera es
  // exactamente el defecto real que Restaurantes corrigió en
  // `fix(notifications): atomically clear dashboard badges`).
  app.post("/hoteles/:hotelId/notificaciones/marcar-todo-leido", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ mark_all_notifications_read: number }>(
      "select public.mark_all_notifications_read() as mark_all_notifications_read;",
    );
    return c.json({ marcadas: rows[0]!.mark_all_notifications_read });
  });

  // Sin `WHERE user_id = ...`: la policy `notification_preference_self` (0113, "for all
  // ... using (user_id = auth.uid())") ya filtra a la fila propia -- repetir la
  // condición en la aplicación sería redundante y daría la falsa impresión de que el
  // filtrado ocurre aquí en vez de en RLS.
  app.get("/notificaciones/preferencias", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ type: string; enabled: boolean }>(
      "select type, enabled from public.notification_preference;",
    );
    return c.json(rows.map((r) => ({ tipo: r.type, activa: r.enabled })));
  });

  app.put("/notificaciones/preferencias", async (c) => {
    const db = c.get("db");
    const input = parseBody(preferenceSchema, await c.req.json().catch(() => ({})));
    await db.query(
      `insert into public.notification_preference (user_id, type, enabled)
       values (auth.uid(), $1, $2)
       on conflict (user_id, type) do update set enabled = excluded.enabled, updated_at = now();`,
      [input.type, input.enabled],
    );
    return c.json({ ok: true });
  });

  return app;
}
