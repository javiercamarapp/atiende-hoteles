// H12b · LAUNCH-007: consola superadmin cross-tenant. Toda la autoridad de lectura/
// escritura cross-tenant vive en `public.admin_negocio()`/`public.admin_reintentar_outbox()`
// (packages/db/migrations/0100_platform_admin_console.sql, patrón Likida/Restaurantes: UNA
// sola función security definer con el check de rol adentro). Esta ruta agrega una SEGUNDA
// capa explícita (defensa en profundidad, mismo criterio que `requireHotelMembership` en
// middleware.ts): un 403 ANTES de tocar la función de negocio cuando el usuario no es
// superadmin de plataforma, en vez de dejar que el `raise exception` de la función sea la
// única barrera.
import { Hono, type Context } from "hono";
import { authMiddleware, dbSession } from "../middleware.ts";
import { Errors } from "../lib/errors.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

type Ctx = Context<HonoEnvBindings>;

async function requirePlatformAdmin(c: Ctx, next: () => Promise<void>): Promise<void> {
  const db = c.get("db");
  const { rows } = await db.query<{ es_admin: boolean }>("select public.is_platform_admin() as es_admin;");
  if (!rows[0]?.es_admin) {
    throw Errors.forbidden("Se requiere rol superadmin de plataforma para acceder a la consola /admin.");
  }
  await next();
}

export function adminRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/admin/*", authMiddleware(deps.env));
  app.use("/admin/*", dbSession(deps.engine));
  app.use("/admin/*", requirePlatformAdmin);

  // Lectura agregada cross-tenant: hoteles, métricas globales, costo de IA por hotel vs
  // techo, agentes/gates, y las señales de salud que la consola necesita (outbox
  // pendientes/dead-letter, aprobaciones vencidas) -- todo en UNA llamada a la única
  // función autorizada a cruzar tenants (evita el error de "recorte silencioso" que
  // negocio.ts de Likida documenta para consultas cross-tenant sin agregar en SQL).
  app.get("/admin/negocio", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ admin_negocio: unknown }>("select public.admin_negocio() as admin_negocio;");
    return c.json(rows[0]?.admin_negocio ?? {});
  });

  // Única escritura operativa permitida desde /admin: reintentar un evento outbox en
  // dead-letter. Acción explícita y auditada (platform_admin_audit_log, dentro de la
  // función SQL) -- nunca un cambio a datos de negocio (reserva/folio/cargo/pago).
  app.post("/admin/outbox/:outboxId/reintentar", async (c) => {
    const db = c.get("db");
    const outboxId = c.req.param("outboxId");
    try {
      await db.query("select public.admin_reintentar_outbox($1);", [outboxId]);
    } catch (err) {
      if (err instanceof Error && err.message.includes("outbox_no_encontrado")) {
        throw Errors.notFound("No existe ese evento de outbox.");
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  // Auditoría de accesos del superadmin (LAUNCH-007): cada llamada a admin_negocio()/
  // admin_reintentar_outbox() queda registrada por la propia función SQL; esta ruta solo
  // la expone para lectura.
  app.get("/admin/auditoria", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query(
      `select id, actor_id, action, detail, created_at
       from public.platform_admin_audit_log
       order by created_at desc
       limit 200;`,
    );
    return c.json(rows);
  });

  return app;
}
