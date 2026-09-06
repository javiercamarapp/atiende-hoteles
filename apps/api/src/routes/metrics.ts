// H8 · ADR-008: /metrics en formato de exposición de Prometheus (texto plano). Sin
// autenticación de usuario final (es infraestructura, como /health) pero SÍ puede
// protegerse con un token compartido opcional (`METRICS_TOKEN`) leído directo de
// `process.env` -- no forma parte de `AppEnv` porque es un secreto operativo, no una
// decisión de negocio, y así un despliegue puede añadir/quitar la protección sin tocar
// el resto de la configuración tipada.
import { Hono } from "hono";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function metricsRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.get("/metrics", async (c) => {
    const token = process.env.METRICS_TOKEN;
    if (token) {
      const provided = c.req.header("x-metrics-token");
      if (provided !== token) {
        return c.text("no autorizado", 401);
      }
    }
    const body = await deps.metrics.render(deps.engine.admin);
    return c.text(body, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  return app;
}
