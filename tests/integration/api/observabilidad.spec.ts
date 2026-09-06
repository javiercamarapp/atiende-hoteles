// H8 · ADR-008 + auditoria-1/seguridad.md — cierra en una sola suite los hallazgos y
// entregables de observabilidad/seguridad de este hito contra la app real (embedded
// Postgres, sin mocks):
//  - CORS con lista explícita de orígenes ([MEDIO] "sin restricción de origen").
//  - Rate limit por IP+usuario con Retry-After ([BAJO], la parte de cabecera).
//  - Cabeceras de seguridad (HSTS solo prod, X-Content-Type-Options, frame-ancestors).
//  - /metrics en formato Prometheus (latencia, errores 5xx, outbox, aprobaciones,
//    reservas creadas).
//  - /health y /ready (BD + migraciones aplicadas).
//  - Alerta estructurada (`nivel: "alerta"`) para errores 5xx en el camino del dinero.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createLogger, loadEnv, MetricsRegistry, RateLimiter, type AppDeps } from "@atiende-hoteles/api";
import {
  openEmbeddedPostgres,
  applyMigrations,
  seedDev,
  DEV_SEED_PASSWORD,
  type EmbeddedPostgresEngine,
  type SeedResult,
} from "@atiende-hoteles/db";
import type { Hono } from "hono";
import type { HonoEnvBindings } from "@atiende-hoteles/api";

function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({}, destination as unknown as import("pino").DestinationStream);
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

async function loginAs(app: Hono<HonoEnvBindings>, email: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`login fallido para ${email}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("H8: observabilidad + seguridad de transporte (integración real)", () => {
  let engine: EmbeddedPostgresEngine;
  let seed: SeedResult;
  let app: Hono<HonoEnvBindings>;
  let captured: ReturnType<typeof capturingLogger>;
  let deps: AppDeps;
  let hotelId: string;
  let gmToken: string;

  beforeAll(async () => {
    engine = await openEmbeddedPostgres();
    await applyMigrations(engine.admin);
    seed = await seedDev(engine.admin);

    captured = capturingLogger();
    const env = loadEnv({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-not-for-production",
      CORS_ALLOWED_ORIGINS: "https://panel.atiende-hoteles.example,http://localhost:5173",
    } as NodeJS.ProcessEnv);
    deps = {
      engine,
      env,
      logger: captured.logger,
      ipLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
      userLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
      metrics: new MetricsRegistry(),
    };
    app = createApp(deps);

    hotelId = seed.hotels[0]!.id;
    gmToken = await loginAs(app, seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await engine.stop();
  });

  describe("CORS: lista explícita de orígenes por entorno", () => {
    it("un origen NO permitido no recibe Access-Control-Allow-Origin (el navegador bloquearía la lectura)", async () => {
      const res = await app.request("/health", { headers: { origin: "https://sitio-cualquiera.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("un origen SÍ permitido (de la lista de env) recibe la cabecera exacta reflejada", async () => {
      const res = await app.request("/health", { headers: { origin: "http://localhost:5173" } });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });

    it("nunca responde con el comodín '*' (ADR-004: Bearer-token, pero igual sin defensa en profundidad barata de perder)", async () => {
      const res = await app.request("/health", { headers: { origin: "http://localhost:5173" } });
      expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    });
  });

  describe("Cabeceras de seguridad", () => {
    it("X-Content-Type-Options: nosniff siempre presente", async () => {
      const res = await app.request("/health");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("Content-Security-Policy declara frame-ancestors 'none' (API nunca embebible)", async () => {
      const res = await app.request("/health");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    });

    it("Strict-Transport-Security NO se envía fuera de producción (NODE_ENV=test aquí)", async () => {
      const res = await app.request("/health");
      expect(res.headers.get("strict-transport-security")).toBeNull();
    });

    it("Strict-Transport-Security SÍ se envía cuando NODE_ENV=production", async () => {
      const prodEnv = loadEnv({
        NODE_ENV: "production",
        JWT_SECRET: "prod-secret-suficientemente-largo-para-pruebas",
        CORS_ALLOWED_ORIGINS: "https://panel.atiende-hoteles.example",
      } as NodeJS.ProcessEnv);
      const prodDeps: AppDeps = { ...deps, env: prodEnv };
      const prodApp = createApp(prodDeps);
      const res = await prodApp.request("/health");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    });
  });

  describe("/metrics (formato de exposición de Prometheus)", () => {
    it("expone latencia por ruta, errores 5xx, outbox, aprobaciones y reservas creadas", async () => {
      // Genera tráfico real: una request exitosa y una fallida en una ruta de dinero.
      await app.request(`/hoteles/${hotelId}/folios/${randomUUID()}`, { headers: { authorization: `Bearer ${gmToken}` } });
      await app.request(`/hoteles/${hotelId}/folios/no-es-un-uuid`, { headers: { authorization: `Bearer ${gmToken}` } });

      const res = await app.request("/metrics");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();

      expect(body).toContain("# TYPE http_request_duration_ms histogram");
      expect(body).toMatch(/http_request_duration_ms_bucket\{.*route="\/health".*\}/);
      expect(body).toContain("# TYPE http_requests_total counter");
      expect(body).toContain("# TYPE http_errors_total counter");
      expect(body).toContain("# TYPE outbox_pending gauge");
      expect(body).toMatch(/outbox_pending \d+/);
      expect(body).toContain("# TYPE outbox_dead_letter gauge");
      expect(body).toContain("approvals_pending");
      expect(body).toContain("reservations_created_total");
    });

    it("los contadores de error suben cuando una ruta de dinero responde 5xx", async () => {
      const metrics = new MetricsRegistry();
      const localDeps: AppDeps = { ...deps, metrics, logger: capturingLogger().logger };
      const localApp = createApp(localDeps);
      await localApp.request(`/hoteles/${hotelId}/folios/valor-invalido-no-uuid`, {
        headers: { authorization: `Bearer ${gmToken}` },
      });
      const body = await (await localApp.request("/metrics")).text();
      // auditoria-2/operabilidad [MEDIO]: ahora lleva etiqueta `hotel` (orden
      // alfabético de labelKey: hotel,method,route) -- antes de este fix no existía
      // ninguna forma de desglosar el error 5xx por hotel desde /metrics.
      expect(body).toMatch(
        new RegExp(`http_errors_total\\{hotel="${hotelId}",method="GET",route="/hoteles/:hotelId/folios/:folioId"\\} [1-9]\\d*`),
      );
    });

    it("los contadores de reservas creadas y de requests HTTP llevan etiqueta hotel (auditoria-2/operabilidad MEDIO)", async () => {
      const metrics = new MetricsRegistry();
      const localDeps: AppDeps = { ...deps, metrics, logger: capturingLogger().logger };
      const localApp = createApp(localDeps);
      await localApp.request(`/hoteles/${hotelId}/disponibilidad`, { headers: { authorization: `Bearer ${gmToken}` } });

      const roomTypeId = seed.hotels[0]!.roomTypes[0]!.id;
      const creada = await localApp.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ roomTypeId, checkInDate: "2026-10-01", checkOutDate: "2026-10-02" }),
      });
      expect(creada.status).toBe(201);

      const body = await (await localApp.request("/metrics")).text();
      expect(body).toMatch(
        new RegExp(`http_requests_total\\{hotel="${hotelId}",method="GET",route="/hoteles/:hotelId/disponibilidad",status="200"\\} 1`),
      );
      expect(body).toMatch(new RegExp(`reservations_created_total\\{hotel="${hotelId}"\\} 1`));
    });
  });

  describe("/health y /ready", () => {
    it("/health responde ok sin tocar la BD", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("/ready responde ok con las migraciones aplicadas contadas", async () => {
      const res = await app.request("/ready");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; migrationsApplied: number };
      expect(body.status).toBe("ok");
      expect(body.migrationsApplied).toBeGreaterThan(0);
    });

    it("/ready responde 503 (no 200) si la BD no está disponible", async () => {
      const brokenEngine = { admin: { query: async () => { throw new Error("conexión caída (simulada)"); } } } as unknown as EmbeddedPostgresEngine;
      const brokenDeps: AppDeps = { ...deps, engine: brokenEngine };
      const brokenApp = createApp(brokenDeps);
      const res = await brokenApp.request("/ready");
      expect(res.status).toBe(503);
    });
  });

  describe("Alerta estructurada del camino del dinero (`nivel: \"alerta\"`)", () => {
    it("un 5xx real en una ruta de folios (dinero) emite un log con nivel:alerta y contexto (route/status/org/hotel)", async () => {
      const local = capturingLogger();
      const localDeps: AppDeps = { ...deps, logger: local.logger, metrics: new MetricsRegistry() };
      const localApp = createApp(localDeps);

      const res = await localApp.request(`/hoteles/${hotelId}/folios/esto-no-es-un-uuid-valido`, {
        headers: { authorization: `Bearer ${gmToken}` },
      });
      expect(res.status).toBe(500);

      // auditoria-2/operabilidad [ALTO]: `createApp()` también emite, una vez, la
      // alerta de arranque "sin destinatario" (tipo distinto) cuando ningún
      // MONEY_ALERT_* está configurado (ver moneyAlert.spec más abajo) -- se filtra
      // por el `tipo` específico de esta prueba, no por `nivel === "alerta"` a secas.
      const alertas = local.parsed().filter((l) => l.nivel === "alerta" && l.tipo === "error_camino_dinero");
      expect(alertas.length).toBeGreaterThanOrEqual(1);
      const alerta = alertas[0]!;
      expect(alerta.tipo).toBe("error_camino_dinero");
      expect(alerta.route).toBe("/hoteles/:hotelId/folios/:folioId");
      expect(alerta.status).toBe(500);
      expect(alerta.hotel_id).toBe(hotelId);
      expect(alerta.request_id).toBeTruthy();
    });

    // auditoria-2/operabilidad [MEDIO]: "la alerta no lleva reservation_id/folio_id/
    // charge_id" -- corregido: un 5xx sobre una ruta con un UUID real en el path ahora
    // trae el identificador de negocio correspondiente.
    it("un 5xx sobre un folio con UUID real en el path: la alerta trae folio_id (auditoria-2/operabilidad MEDIO)", async () => {
      const local = capturingLogger();
      const folioIdReal = randomUUID();
      // Motor roto en withAppSession (dbSession corre ANTES de tocar el folio real) --
      // fuerza un 500 real dentro del pipeline de la ruta, sin necesitar un folio
      // existente de verdad; el path crudo SÍ trae el UUID real igual.
      const brokenEngine = {
        admin: deps.engine.admin,
        withAppSession: () => {
          throw new Error("conexión caída (simulada)");
        },
      } as unknown as EmbeddedPostgresEngine;
      const localDeps: AppDeps = { ...deps, logger: local.logger, engine: brokenEngine, metrics: new MetricsRegistry() };
      const localApp = createApp(localDeps);

      const res = await localApp.request(`/hoteles/${hotelId}/folios/${folioIdReal}`, {
        headers: { authorization: `Bearer ${gmToken}` },
      });
      expect(res.status).toBe(500);

      const alertas = local.parsed().filter((l) => l.nivel === "alerta" && l.tipo === "error_camino_dinero");
      expect(alertas.length).toBeGreaterThanOrEqual(1);
      expect(alertas[0]!.folio_id).toBe(folioIdReal);
    });

    it("un 4xx normal (no 5xx) en una ruta de dinero NO dispara la alerta (solo errores reales del sistema)", async () => {
      const local = capturingLogger();
      const localDeps: AppDeps = { ...deps, logger: local.logger, metrics: new MetricsRegistry() };
      const localApp = createApp(localDeps);

      const res = await localApp.request(`/hoteles/${hotelId}/folios/${randomUUID()}`, {
        headers: { authorization: `Bearer ${gmToken}` },
      });
      expect(res.status).toBe(404); // folio inexistente, pero UUID válido: 404, no 500.
      expect(local.parsed().some((l) => l.nivel === "alerta" && l.tipo === "error_camino_dinero")).toBe(false);
    });

    it("un 5xx en una ruta que NO es del camino del dinero (/health simulando falla) no dispara la alerta", async () => {
      const local = capturingLogger();
      const brokenEngine = { admin: { query: async () => { throw new Error("caída simulada"); } } } as unknown as EmbeddedPostgresEngine;
      const localDeps: AppDeps = { ...deps, logger: local.logger, engine: brokenEngine, metrics: new MetricsRegistry() };
      const localApp = createApp(localDeps);
      const res = await localApp.request("/ready");
      expect(res.status).toBe(503); // no es 5xx además, pero confirma que /ready nunca es "money path"
      expect(local.parsed().some((l) => l.nivel === "alerta" && l.tipo === "error_camino_dinero")).toBe(false);
    });

    // auditoria-2/operabilidad [ALTO]: "la alerta del camino del dinero no tiene ningún
    // destinatario -- es una línea de log a stdout". Corregido: sin ningún
    // MONEY_ALERT_* configurado, el proceso lo declara al arrancar y /ready lo refleja.
    it("sin MONEY_ALERT_WEBHOOK_URL/MONEY_ALERT_EMAIL_*: createApp() declara la brecha al arrancar y GET /ready la refleja", async () => {
      const previo = {
        webhook: process.env.MONEY_ALERT_WEBHOOK_URL,
        emailTo: process.env.MONEY_ALERT_EMAIL_TO,
        emailWebhook: process.env.MONEY_ALERT_EMAIL_WEBHOOK_URL,
      };
      delete process.env.MONEY_ALERT_WEBHOOK_URL;
      delete process.env.MONEY_ALERT_EMAIL_TO;
      delete process.env.MONEY_ALERT_EMAIL_WEBHOOK_URL;
      try {
        const local = capturingLogger();
        const localDeps: AppDeps = { ...deps, logger: local.logger, metrics: new MetricsRegistry() };
        const localApp = createApp(localDeps);

        const startupAlerts = local.parsed().filter((l) => l.nivel === "alerta" && l.tipo === "alerta_camino_dinero_sin_destinatario");
        expect(startupAlerts.length).toBe(1);

        const res = await localApp.request("/ready");
        expect(res.status).toBe(200);
        expect((await res.json()) as { moneyAlertsConfigured: boolean }).toMatchObject({ moneyAlertsConfigured: false });
      } finally {
        if (previo.webhook !== undefined) process.env.MONEY_ALERT_WEBHOOK_URL = previo.webhook;
        if (previo.emailTo !== undefined) process.env.MONEY_ALERT_EMAIL_TO = previo.emailTo;
        if (previo.emailWebhook !== undefined) process.env.MONEY_ALERT_EMAIL_WEBHOOK_URL = previo.emailWebhook;
      }
    });

    it("con MONEY_ALERT_WEBHOOK_URL configurado: NO declara la brecha al arrancar, y GET /ready refleja moneyAlertsConfigured: true", async () => {
      const previo = process.env.MONEY_ALERT_WEBHOOK_URL;
      process.env.MONEY_ALERT_WEBHOOK_URL = "https://hooks.example.com/atiende-hoteles";
      try {
        const local = capturingLogger();
        const localDeps: AppDeps = { ...deps, logger: local.logger, metrics: new MetricsRegistry() };
        const localApp = createApp(localDeps);

        expect(local.parsed().some((l) => l.tipo === "alerta_camino_dinero_sin_destinatario")).toBe(false);

        const res = await localApp.request("/ready");
        expect((await res.json()) as { moneyAlertsConfigured: boolean }).toMatchObject({ moneyAlertsConfigured: true });
      } finally {
        if (previo === undefined) delete process.env.MONEY_ALERT_WEBHOOK_URL;
        else process.env.MONEY_ALERT_WEBHOOK_URL = previo;
      }
    });
  });
});
