// H2 · ADR-008: /health (proceso) y /ready (conexión Postgres + migraciones aplicadas).
import { Hono } from "hono";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function healthRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (c) => {
    try {
      const { rows } = await deps.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.schema_migrations;",
      );
      const migrationsApplied = Number(rows[0]?.count ?? "0");
      if (migrationsApplied === 0) {
        return c.json({ status: "not_ready", reason: "sin migraciones aplicadas" }, 503);
      }
      return c.json({ status: "ok", migrationsApplied });
    } catch {
      return c.json({ status: "not_ready", reason: "base de datos no disponible" }, 503);
    }
  });

  return app;
}
