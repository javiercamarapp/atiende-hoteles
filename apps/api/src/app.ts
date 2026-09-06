// H2 · Ensamblado de la app Hono (ADR-004). `createApp(deps)` NO arranca un servidor
// HTTP: devuelve la instancia de Hono, que se puede invocar directamente con
// `app.fetch(request)`/`app.request(path, init)` en tests (sin abrir un socket real,
// ver tests/support/api-fixture.ts) o montarse sobre `@hono/node-server` en
// `server.ts` para correr de verdad.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { FakeStripeAdapter } from "@atiende-hoteles/mcp-payments";
import { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } from "@atiende-hoteles/mcp-cfdi";
import { authRoutes } from "./routes/auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { metricsRoutes } from "./routes/metrics.ts";
import { hotelesRoutes } from "./routes/hoteles.ts";
import { resumenRoutes } from "./routes/resumen.ts";
import { reservasRoutes } from "./routes/reservas.ts";
import { disponibilidadRoutes } from "./routes/disponibilidad.ts";
import { huespedesRoutes } from "./routes/huespedes.ts";
import { foliosRoutes } from "./routes/folios.ts";
import { nightAuditRoutes } from "./routes/night-audit.ts";
import { cfdiRoutes } from "./routes/cfdi.ts";
import { quotesRoutes } from "./routes/quotes.ts";
import { tarifasRoutes } from "./routes/tarifas.ts";
import { cancelacionPublicaRoutes } from "./routes/cancelacionPublica.ts";
import { experienciasPublicasRoutes } from "./routes/experienciasPublicas.ts";
import { identidadRoutes } from "./routes/identidad.ts";
import { housekeepingRoutes } from "./routes/housekeeping.ts";
import { mantenimientoRoutes } from "./routes/mantenimiento.ts";
import { aprobacionesRoutes } from "./routes/aprobaciones.ts";
import { mensajeriaRoutes } from "./routes/mensajeria.ts";
import { toErrorBody } from "./lib/errors.ts";
import { buildMoneyAlertLog, isMoneyPath } from "./lib/moneyAlert.ts";
import { ipRateLimit, requestId, userRateLimit } from "./middleware.ts";
import type { AppDeps, HonoEnvBindings, ResolvedAppDeps } from "./types.ts";

export function createApp(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // H5 · REQ-INT-002/REQ-INT-005: sin credenciales reales del PSP/PAC, `createApp`
  // instancia UN adaptador simulado compartido por proceso (su idempotencia interna
  // vive en memoria -- crear uno nuevo por request rompería esa garantía) etiquetado
  // `simulated: true` (ver `status()` de cada adaptador) -- nunca se fabrica un
  // resultado "real" para aparentar que la integración está completa.
  const resolvedDeps: ResolvedAppDeps = {
    ...deps,
    payments: deps.payments ?? new FakeStripeAdapter(),
    cfdi: deps.cfdi ?? new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter()),
  };

  // REQ-SEG (auditoria-1/seguridad.md [MEDIO] CORS): lista blanca explícita por
  // entorno (env.corsAllowedOrigins), nunca "*" -- un origen no listado no recibe
  // NINGUNA cabecera Access-Control-Allow-Origin (el navegador bloquea la lectura de
  // la respuesta desde ese origen).
  app.use(
    "*",
    cors({
      origin: deps.env.corsAllowedOrigins,
      credentials: false,
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Hotel-Id", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id", "Retry-After"],
    }),
  );

  // Cabeceras de seguridad (auditoria-1/seguridad.md): HSTS solo en producción (nunca
  // en dev/test sobre HTTP plano, donde el navegador la ignoraría pero declararla es
  // información falsa), X-Content-Type-Options siempre, frame-ancestors 'none' (esta
  // API nunca sirve HTML embebible en un iframe de otro origen).
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: deps.env.nodeEnv === "production" ? "max-age=15552000; includeSubDomains" : false,
      xContentTypeOptions: true,
      contentSecurityPolicy: { frameAncestors: ["'none'"] },
      xFrameOptions: "DENY",
    }),
  );

  app.use("*", requestId());
  app.use("*", ipRateLimit(deps));
  app.use("*", userRateLimit(deps));

  app.use("*", async (c: Context<HonoEnvBindings>, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const route = c.req.routePath || c.req.path;
    deps.metrics.recordRequest(route, c.req.method, c.res.status, durationMs);
    if (c.req.method === "POST" && route === "/hoteles/:hotelId/reservas" && c.res.status === 201) {
      deps.metrics.incrementReservationsCreated();
    }
    deps.logger.info(
      {
        request_id: c.get("requestId"),
        org_id: c.get("orgId"),
        hotel_id: c.get("hotelIds")?.[0],
        user_id: c.get("userId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: durationMs,
      },
      "request",
    );

    // ADR-008 "errores del camino del dinero con alerta estructurada": cualquier 5xx
    // en una ruta de cargos/pagos/CFDI/folios/reservas emite además un log con
    // `nivel: "alerta"` -- cubre también las respuestas 500 devueltas directamente por
    // un handler (sin pasar por `app.onError`, ver más abajo).
    if (c.res.status >= 500 && isMoneyPath(route)) {
      deps.logger.error(
        buildMoneyAlertLog({
          requestId: c.get("requestId") ?? "sin-id",
          route,
          method: c.req.method,
          status: c.res.status,
          orgId: c.get("orgId"),
          hotelId: c.get("hotelIds")?.[0],
          userId: c.get("userId"),
          errorMessage: c.error?.message,
        }),
        "alerta_camino_dinero",
      );
    }
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "sin-id";
    const { status, body } = toErrorBody(err, requestId);
    if (err instanceof Error && "headers" in err) {
      const headers = (err as Error & { headers?: Record<string, string> }).headers;
      if (headers) for (const [k, v] of Object.entries(headers)) c.header(k, v);
    }
    if (status >= 500) {
      deps.logger.error({ request_id: requestId, err: err instanceof Error ? err.message : String(err) }, "error_interno");
    }
    // La alerta estructurada del camino del dinero (`nivel: "alerta"`) se emite una
    // sola vez, en el middleware general de abajo (después de `await next()`): ese
    // punto ve el status final SIN IMPORTAR si vino de un `throw` (manejado aquí) o de
    // un handler que devolvió un 5xx directo con `c.json(...)` -- evita duplicar el log
    // si lo hiciéramos también aquí.
    return c.json(body, status as 400);
  });

  app.route("/", healthRoutes(deps));
  app.route("/", metricsRoutes(deps));
  app.route("/", authRoutes(deps));
  app.route("/", hotelesRoutes(deps));
  app.route("/", resumenRoutes(deps));
  app.route("/", reservasRoutes(deps));
  app.route("/", disponibilidadRoutes(deps));
  app.route("/", huespedesRoutes(deps));
  app.route("/", foliosRoutes(resolvedDeps));
  app.route("/", nightAuditRoutes(deps));
  app.route("/", cfdiRoutes(resolvedDeps));
  app.route("/", quotesRoutes(deps));
  app.route("/", tarifasRoutes(deps));
  app.route("/", cancelacionPublicaRoutes(deps));
  app.route("/", experienciasPublicasRoutes(deps));
  app.route("/", identidadRoutes(deps));
  app.route("/", housekeepingRoutes(deps));
  app.route("/", mantenimientoRoutes(deps));
  app.route("/", aprobacionesRoutes(deps));
  app.route("/", mensajeriaRoutes(deps));

  return app;
}
