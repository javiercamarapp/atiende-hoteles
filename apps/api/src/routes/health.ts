// H2 · ADR-008: /health (proceso) y /ready (conexión Postgres + migraciones aplicadas).
import { Hono } from "hono";
import { hasMoneyAlertDestination, resolveMoneyAlertDestination } from "../lib/moneyAlert.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function healthRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (c) => {
    // auditoria-2/operabilidad [ALTO]: la falta de destinatario para las alertas del
    // camino del dinero NO tumba la disponibilidad del proceso (nunca 503 por esto
    // solo) -- es una advertencia operativa, no una condición de "no listo para
    // recibir tráfico". Se refleja igual en la respuesta para que sea visible sin leer
    // el log de arranque completo.
    const moneyAlertsConfigured = hasMoneyAlertDestination(resolveMoneyAlertDestination());
    try {
      const { rows } = await deps.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.schema_migrations;",
      );
      const migrationsApplied = Number(rows[0]?.count ?? "0");
      if (migrationsApplied === 0) {
        return c.json({ status: "not_ready", reason: "sin migraciones aplicadas", moneyAlertsConfigured }, 503);
      }
      return c.json({ status: "ok", migrationsApplied, moneyAlertsConfigured });
    } catch {
      return c.json({ status: "not_ready", reason: "base de datos no disponible", moneyAlertsConfigured }, 503);
    }
  });

  return app;
}
