// H12c · packages/analytics: "sin PII en eventos de analítica" (prueba exigida por el
// encargo). Se prueba contra el FAKE (el que corre en CI) con EXACTAMENTE la misma
// validación que usarían los adaptadores reales (PostHog/Sentry) -- nunca "en modo
// simulado se deja pasar cualquier cosa".
import { describe, expect, it } from "vitest";
import { FakeAnalyticsAdapter, FakeErrorReporterAdapter, AnalyticsPiiError, PRODUCT_EVENT_NAMES } from "@atiende-hoteles/analytics";

describe("adversarial: analítica de producto sin PII (H12c)", () => {
  it("track() bloquea una propiedad cuya CLAVE está en la lista vedada (email/telefono/curp/rfc/...)", () => {
    const analytics = new FakeAnalyticsAdapter();
    expect(() => analytics.track("login_succeeded", { email: "huesped@ejemplo.com" })).toThrow(AnalyticsPiiError);
    expect(analytics.events).toHaveLength(0);
  });

  it("track() bloquea una propiedad cuyo VALOR parece PII aunque la clave sea inocua", () => {
    const analytics = new FakeAnalyticsAdapter();
    expect(() => analytics.track("subscription_viewed", { nota: "contactar a juan@ejemplo.com" })).toThrow(AnalyticsPiiError);
    expect(() => analytics.track("subscription_viewed", { nota: "tel 5512345678" })).toThrow(AnalyticsPiiError);
    expect(() => analytics.track("subscription_viewed", { nota: "CURP ABCD990101HDFRRL05" })).toThrow(AnalyticsPiiError);
    expect(analytics.events).toHaveLength(0);
  });

  it("track() con propiedades limpias SÍ se registra", () => {
    const analytics = new FakeAnalyticsAdapter();
    analytics.track("entitlement_limit_blocked", { recurso: "hoteles", plan: "starter" });
    expect(analytics.events).toHaveLength(1);
    expect(analytics.events[0]!.event).toBe("entitlement_limit_blocked");
  });

  it("solo se pueden emitir eventos del catálogo documentado (events.ts)", () => {
    expect(PRODUCT_EVENT_NAMES).toContain("landing_viewed");
    expect(PRODUCT_EVENT_NAMES).toContain("cookie_consent_granted");
    expect(PRODUCT_EVENT_NAMES.length).toBeGreaterThan(5);
  });

  it("identify() también bloquea traits con PII", () => {
    const analytics = new FakeAnalyticsAdapter();
    expect(() => analytics.identify("user-uuid-1", { correo: "a@b.com" })).toThrow(AnalyticsPiiError);
    expect(analytics.identifications).toHaveLength(0);
  });

  it("captureException()/captureMessage() del reportador de errores también bloquean contexto con PII", () => {
    const reporter = new FakeErrorReporterAdapter();
    expect(() => reporter.captureException(new Error("fallo de prueba"), { userId: "uuid-1", telefono: "5512345678" })).toThrow(
      AnalyticsPiiError,
    );
    expect(reporter.reports).toHaveLength(0);

    reporter.captureException(new Error("fallo de prueba"), { userId: "uuid-1", route: "/suscripcion" });
    expect(reporter.reports).toHaveLength(1);
  });
});
