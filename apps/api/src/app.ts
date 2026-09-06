// H2 · Ensamblado de la app Hono (ADR-004). `createApp(deps)` NO arranca un servidor
// HTTP: devuelve la instancia de Hono, que se puede invocar directamente con
// `app.fetch(request)`/`app.request(path, init)` en tests (sin abrir un socket real,
// ver tests/support/api-fixture.ts) o montarse sobre `@hono/node-server` en
// `server.ts` para correr de verdad.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { hotelesRoutes } from "./routes/hoteles.ts";
import { resumenRoutes } from "./routes/resumen.ts";
import { reservasRoutes } from "./routes/reservas.ts";
import { disponibilidadRoutes } from "./routes/disponibilidad.ts";
import { huespedesRoutes } from "./routes/huespedes.ts";
import { foliosRoutes } from "./routes/folios.ts";
import { quotesRoutes } from "./routes/quotes.ts";
import { tarifasRoutes } from "./routes/tarifas.ts";
import { ocupacionRoutes } from "./routes/ocupacion.ts";
import { cancelacionPublicaRoutes } from "./routes/cancelacionPublica.ts";
import { toErrorBody } from "./lib/errors.ts";
import { ipRateLimit, requestId, userRateLimit } from "./middleware.ts";
import type { AppDeps, HonoEnvBindings } from "./types.ts";

export function createApp(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("*", cors());
  app.use("*", requestId());
  app.use("*", ipRateLimit(deps));
  app.use("*", userRateLimit(deps));

  app.use("*", async (c: Context<HonoEnvBindings>, next) => {
    const start = Date.now();
    await next();
    deps.logger.info(
      {
        request_id: c.get("requestId"),
        org_id: c.get("orgId"),
        hotel_id: c.get("hotelIds")?.[0],
        user_id: c.get("userId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Date.now() - start,
      },
      "request",
    );
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "sin-id";
    const { status, body } = toErrorBody(err, requestId);
    if (status >= 500) {
      deps.logger.error({ request_id: requestId, err: err instanceof Error ? err.message : String(err) }, "error_interno");
    }
    return c.json(body, status as 400);
  });

  app.route("/", healthRoutes(deps));
  app.route("/", authRoutes(deps));
  app.route("/", hotelesRoutes(deps));
  app.route("/", resumenRoutes(deps));
  app.route("/", reservasRoutes(deps));
  app.route("/", disponibilidadRoutes(deps));
  app.route("/", huespedesRoutes(deps));
  app.route("/", foliosRoutes(deps));
  app.route("/", quotesRoutes(deps));
  app.route("/", tarifasRoutes(deps));
  app.route("/", ocupacionRoutes(deps));
  app.route("/", cancelacionPublicaRoutes(deps));

  return app;
}
