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
import { listaEsperaRoutes } from "./routes/listaEspera.ts";
import { disponibilidadRoutes } from "./routes/disponibilidad.ts";
import { recepcionRoutes } from "./routes/recepcion.ts";
import { huespedesRoutes } from "./routes/huespedes.ts";
import { foliosRoutes } from "./routes/folios.ts";
import { nightAuditRoutes } from "./routes/night-audit.ts";
import { cfdiRoutes } from "./routes/cfdi.ts";
import { quotesRoutes } from "./routes/quotes.ts";
import { tarifasRoutes } from "./routes/tarifas.ts";
import { cancelacionPublicaRoutes } from "./routes/cancelacionPublica.ts";
import { experienciasPublicasRoutes } from "./routes/experienciasPublicas.ts";
import { identidadRoutes } from "./routes/identidad.ts";
import { conocimientoLocalRoutes } from "./routes/conocimientoLocal.ts";
import { backOfficeRoutes } from "./routes/backOffice.ts";
import { plUsaliRoutes } from "./routes/plUsali.ts";
import { fraudeRoutes } from "./routes/fraude.ts";
import { pedidosFnbRoutes } from "./routes/pedidosFnb.ts";
import { checkinOnlineRoutes } from "./routes/checkinOnline.ts";
import { housekeepingRoutes } from "./routes/housekeeping.ts";
import { mantenimientoRoutes } from "./routes/mantenimiento.ts";
import { ticketsRoutes } from "./routes/tickets.ts";
import { reputacionRoutes } from "./routes/reputacion.ts";
import { asistenciaRoutes } from "./routes/asistencia.ts";
import { aprobacionesRoutes } from "./routes/aprobaciones.ts";
import { aprobacionesWhatsappRoutes } from "./routes/aprobacionesWhatsapp.ts";
import { mensajeriaRoutes } from "./routes/mensajeria.ts";
import { agentesRoutes } from "./routes/agentes.ts";
import { roiRoutes } from "./routes/roi.ts";
import { privacidadRoutes } from "./routes/privacidad.ts";
import { toErrorBody } from "./lib/errors.ts";
import {
  buildMoneyAlertLog,
  buildNoDestinationStartupLog,
  dispatchMoneyAlert,
  hasMoneyAlertDestination,
  isMoneyPath,
  resolveMoneyAlertDestination,
} from "./lib/moneyAlert.ts";
import { ipRateLimit, requestId, userRateLimit } from "./middleware.ts";
import type { AppDeps, HonoEnvBindings, ResolvedAppDeps } from "./types.ts";

export function createApp(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // auditoria-2/operabilidad [ALTO]: la alerta del camino del dinero (`nivel: "alerta"`
  // más abajo) no tenía NINGÚN destinatario -- solo una línea de log a stdout, sin
  // webhook/correo configurable (REQ-BO-034, todavía `pendiente` en
  // docs/REQUISITOS.md). `createApp()` corre una única vez al arrancar el proceso real
  // (server.ts) -- si ningún destino está configurado, se declara explícitamente aquí
  // en vez de quedar como una brecha silenciosa que solo se nota leyendo el código.
  const moneyAlertDestination = resolveMoneyAlertDestination();
  if (!hasMoneyAlertDestination(moneyAlertDestination)) {
    deps.logger.error(buildNoDestinationStartupLog(), "alerta_camino_dinero_sin_destinatario");
  }

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
    // auditoria-2/operabilidad [MEDIO]: etiqueta `hotel` en las métricas HTTP -- antes
    // no existía ninguna forma de desglosar tráfico/errores/reservas por hotel desde
    // `/metrics` sin cruzar contra los logs estructurados.
    const hotelIdParaMetricas = c.get("hotelIds")?.[0];
    deps.metrics.recordRequest(route, c.req.method, c.res.status, durationMs, hotelIdParaMetricas);
    if (c.req.method === "POST" && route === "/hoteles/:hotelId/reservas" && c.res.status === 201) {
      deps.metrics.incrementReservationsCreated(hotelIdParaMetricas);
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
      const alerta = buildMoneyAlertLog({
        requestId: c.get("requestId") ?? "sin-id",
        route,
        method: c.req.method,
        status: c.res.status,
        orgId: c.get("orgId"),
        hotelId: c.get("hotelIds")?.[0],
        userId: c.get("userId"),
        errorMessage: c.error?.message,
        // auditoria-2/operabilidad [MEDIO]: path crudo (con IDs reales), SOLO para que
        // buildMoneyAlertLog extraiga reservation_id/folio_id/charge_id/payment_id --
        // `route` sigue siendo el patrón sin resolver (agregación por Prometheus/grep
        // sin explosión de cardinalidad).
        rawPath: c.req.path,
      });
      deps.logger.error(alerta, "alerta_camino_dinero");
      // auditoria-2/operabilidad [ALTO]: entrega real al destino configurado (si hay
      // uno, ver `hasMoneyAlertDestination` arriba) -- SIN `await` dentro del ciclo de
      // respuesta: un webhook lento/caído nunca debe añadir latencia (ni un segundo
      // fallo) al request que ya falló. `dispatchMoneyAlert` nunca lanza (atrapa sus
      // propios errores de red y los loguea), así que este `.catch` es solo una red de
      // seguridad adicional por si un caso no contemplado se escapa.
      void dispatchMoneyAlert(alerta, moneyAlertDestination, { logger: deps.logger }).catch((err) => {
        deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "fallo inesperado entregando alerta_camino_dinero");
      });
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
  app.route("/", listaEsperaRoutes(deps));
  app.route("/", disponibilidadRoutes(deps));
  app.route("/", recepcionRoutes(deps));
  app.route("/", huespedesRoutes(deps));
  app.route("/", foliosRoutes(resolvedDeps));
  app.route("/", nightAuditRoutes(deps));
  app.route("/", cfdiRoutes(resolvedDeps));
  app.route("/", quotesRoutes(deps));
  app.route("/", tarifasRoutes(deps));
  app.route("/", cancelacionPublicaRoutes(deps));
  app.route("/", experienciasPublicasRoutes(deps));
  app.route("/", identidadRoutes(deps));
  app.route("/", conocimientoLocalRoutes(deps));
  app.route("/", backOfficeRoutes(deps));
  app.route("/", plUsaliRoutes(deps));
  app.route("/", fraudeRoutes(deps));
  app.route("/", pedidosFnbRoutes(deps));
  app.route("/", checkinOnlineRoutes(deps));
  app.route("/", housekeepingRoutes(deps));
  app.route("/", mantenimientoRoutes(deps));
  app.route("/", ticketsRoutes(deps));
  app.route("/", reputacionRoutes(deps));
  app.route("/", asistenciaRoutes(deps));
  // REQ-UX-006: webhook público (sin sesión de staff) montado ANTES de la ruta
  // autenticada -- mismo criterio de orden que routes/mensajeria.ts.
  app.route("/", aprobacionesWhatsappRoutes(deps));
  app.route("/", aprobacionesRoutes(deps));
  app.route("/", mensajeriaRoutes(deps));
  app.route("/", agentesRoutes(deps));
  app.route("/", roiRoutes(deps));
  app.route("/", privacidadRoutes(deps));

  return app;
}
