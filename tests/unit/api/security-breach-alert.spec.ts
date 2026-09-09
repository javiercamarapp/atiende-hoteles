// REQ-SEG-009 (H19-010/BP-153) — fija el contrato de apps/api/src/lib/securityBreachAlert.ts,
// mismo patrón ya aceptado para el camino del dinero (tests/unit/api/money-alert-destination.spec.ts,
// ADR-008): resolución de destino desde env, criterio de "vulneración significativa",
// construcción del log de alerta, entrega real (webhook/correo) sin bloquear ni lanzar, y
// el log de arranque cuando no hay ningún destino configurado. Cobertura end-to-end de la
// ruta real (POST /hoteles/:hotelId/incidentes/brecha) en tests/integration/api/incidentes.spec.ts.
import { describe, expect, it, vi } from "vitest";
import {
  buildNoDestinationStartupLog,
  buildSecurityBreachAlertLog,
  dispatchSecurityBreachAlert,
  esVulneracionSignificativa,
  hasSecurityBreachAlertDestination,
  resolveSecurityBreachAlertDestination,
} from "../../../apps/api/src/lib/securityBreachAlert.ts";

describe("resolveSecurityBreachAlertDestination / hasSecurityBreachAlertDestination", () => {
  it("sin ninguna variable de entorno: sin destino", () => {
    const config = resolveSecurityBreachAlertDestination({} as NodeJS.ProcessEnv);
    expect(hasSecurityBreachAlertDestination(config)).toBe(false);
  });

  it("con SECURITY_BREACH_ALERT_WEBHOOK_URL: hay destino", () => {
    const config = resolveSecurityBreachAlertDestination({
      SECURITY_BREACH_ALERT_WEBHOOK_URL: "https://hooks.example.com/brecha",
    } as NodeJS.ProcessEnv);
    expect(hasSecurityBreachAlertDestination(config)).toBe(true);
  });

  it("con solo SECURITY_BREACH_ALERT_EMAIL_TO (sin el webhook de correo): NO cuenta como destino", () => {
    const config = resolveSecurityBreachAlertDestination({
      SECURITY_BREACH_ALERT_EMAIL_TO: "legal@hotel.com",
    } as NodeJS.ProcessEnv);
    expect(hasSecurityBreachAlertDestination(config)).toBe(false);
  });

  it("con SECURITY_BREACH_ALERT_EMAIL_TO + SECURITY_BREACH_ALERT_EMAIL_WEBHOOK_URL: hay destino", () => {
    const config = resolveSecurityBreachAlertDestination({
      SECURITY_BREACH_ALERT_EMAIL_TO: "legal@hotel.com",
      SECURITY_BREACH_ALERT_EMAIL_WEBHOOK_URL: "https://relay.example.com/correo",
    } as NodeJS.ProcessEnv);
    expect(hasSecurityBreachAlertDestination(config)).toBe(true);
  });

  it("namespace INDEPENDIENTE de MONEY_ALERT_* -- variables de dinero no cuentan como destino de brecha", () => {
    const config = resolveSecurityBreachAlertDestination({
      MONEY_ALERT_WEBHOOK_URL: "https://hooks.example.com/dinero",
    } as NodeJS.ProcessEnv);
    expect(hasSecurityBreachAlertDestination(config)).toBe(false);
  });
});

describe("esVulneracionSignificativa (REQ-SEG-009: 'una brecha de datos de pasaporte se considera vulneración significativa')", () => {
  it("pasaporte/INE/documento_identidad: significativa", () => {
    expect(esVulneracionSignificativa(["pasaporte"])).toBe(true);
    expect(esVulneracionSignificativa(["ine"])).toBe(true);
    expect(esVulneracionSignificativa(["documento_identidad"])).toBe(true);
  });

  it("credenciales fiscales (e.firma/CSD, REQ-SEG-010): significativa", () => {
    expect(esVulneracionSignificativa(["efirma"])).toBe(true);
    expect(esVulneracionSignificativa(["csd"])).toBe(true);
  });

  it("categorías ajenas (ej. nombre/teléfono sueltos): NO significativa por sí solas", () => {
    expect(esVulneracionSignificativa(["nombre", "telefono"])).toBe(false);
    expect(esVulneracionSignificativa([])).toBe(false);
  });

  it("mezcla: basta con que UNA de las categorías involucradas sea significativa", () => {
    expect(esVulneracionSignificativa(["nombre", "pasaporte", "telefono"])).toBe(true);
  });
});

describe("buildSecurityBreachAlertLog / buildNoDestinationStartupLog", () => {
  it("declara nivel:alerta y el tipo explícito de brecha", () => {
    const log = buildSecurityBreachAlertLog({
      incidentId: "11111111-1111-1111-1111-111111111111",
      requestId: "req-1",
      orgId: "org-1",
      hotelId: "hotel-1",
      categoria: "documento_identidad",
      descripcion: "Acceso no autorizado a la bóveda de identidad.",
      datosInvolucrados: ["pasaporte"],
      vulneracionSignificativa: true,
      detectadoEn: "2026-09-08T00:00:00.000Z",
    });
    expect(log.nivel).toBe("alerta");
    expect(log.tipo).toBe("brecha_seguridad_detectada");
    expect(log.vulneracion_significativa).toBe(true);
  });

  it("buildNoDestinationStartupLog declara nivel:alerta y el tipo explícito de sin-destinatario", () => {
    const log = buildNoDestinationStartupLog();
    expect(log.nivel).toBe("alerta");
    expect(log.tipo).toBe("alerta_brecha_seguridad_sin_destinatario");
  });
});

describe("dispatchSecurityBreachAlert", () => {
  const alerta = { nivel: "alerta", tipo: "brecha_seguridad_detectada", categoria: "documento_identidad" };

  it("sin destino configurado: no hace ninguna llamada de red", async () => {
    const fetchFn = vi.fn();
    await dispatchSecurityBreachAlert(alerta, {}, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("con webhook configurado: hace POST con el JSON completo de la alerta", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchSecurityBreachAlert(
      alerta,
      { webhookUrl: "https://hooks.example.com/brecha" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/brecha");
    expect(JSON.parse(init.body)).toEqual(alerta);
  });

  it("con correo configurado: hace POST con {to, subject, alert}", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchSecurityBreachAlert(
      alerta,
      { emailTo: "legal@hotel.com", emailWebhookUrl: "https://relay.example.com/correo" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://relay.example.com/correo");
    const body = JSON.parse(init.body);
    expect(body.to).toBe("legal@hotel.com");
    expect(body.alert).toEqual(alerta);
  });

  it("un webhook caído/con error NUNCA lanza -- se loguea y se resuelve igual", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const logger = { error: vi.fn() };
    await expect(
      dispatchSecurityBreachAlert(alerta, { webhookUrl: "https://hooks.example.com/brecha" }, { fetchFn: fetchFn as unknown as typeof fetch, logger }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
