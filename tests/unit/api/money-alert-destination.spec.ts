// auditoria-2/operabilidad [ALTO] · "La alerta del camino del dinero no tiene ningún
// destinatario — es una línea de log a stdout". Estas pruebas fijan el contrato de
// apps/api/src/lib/moneyAlert.ts después del fix: resolución de destino desde env,
// entrega real (webhook/correo) sin bloquear ni lanzar, y el log de arranque cuando no
// hay ningún destino configurado.
import { describe, expect, it, vi } from "vitest";
import {
  buildNoDestinationStartupLog,
  dispatchMoneyAlert,
  hasMoneyAlertDestination,
  resolveMoneyAlertDestination,
} from "../../../apps/api/src/lib/moneyAlert.ts";

describe("resolveMoneyAlertDestination / hasMoneyAlertDestination", () => {
  it("sin ninguna variable de entorno: sin destino", () => {
    const config = resolveMoneyAlertDestination({});
    expect(hasMoneyAlertDestination(config)).toBe(false);
  });

  it("con MONEY_ALERT_WEBHOOK_URL: hay destino", () => {
    const config = resolveMoneyAlertDestination({ MONEY_ALERT_WEBHOOK_URL: "https://hooks.example.com/x" } as NodeJS.ProcessEnv);
    expect(hasMoneyAlertDestination(config)).toBe(true);
  });

  it("con solo MONEY_ALERT_EMAIL_TO (sin el webhook de correo): NO cuenta como destino", () => {
    const config = resolveMoneyAlertDestination({ MONEY_ALERT_EMAIL_TO: "ops@hotel.com" } as NodeJS.ProcessEnv);
    expect(hasMoneyAlertDestination(config)).toBe(false);
  });

  it("con MONEY_ALERT_EMAIL_TO + MONEY_ALERT_EMAIL_WEBHOOK_URL: hay destino", () => {
    const config = resolveMoneyAlertDestination({
      MONEY_ALERT_EMAIL_TO: "ops@hotel.com",
      MONEY_ALERT_EMAIL_WEBHOOK_URL: "https://relay.example.com/correo",
    } as NodeJS.ProcessEnv);
    expect(hasMoneyAlertDestination(config)).toBe(true);
  });
});

describe("buildNoDestinationStartupLog", () => {
  it("declara nivel:alerta y el tipo explícito de brecha", () => {
    const log = buildNoDestinationStartupLog();
    expect(log.nivel).toBe("alerta");
    expect(log.tipo).toBe("alerta_camino_dinero_sin_destinatario");
  });
});

describe("dispatchMoneyAlert", () => {
  const alerta = { nivel: "alerta", tipo: "error_camino_dinero", route: "/hoteles/:hotelId/folios/:folioId" };

  it("sin destino configurado: no hace ninguna llamada de red", async () => {
    const fetchFn = vi.fn();
    await dispatchMoneyAlert(alerta, {}, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("con webhook configurado: hace POST con el JSON completo de la alerta", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchMoneyAlert(alerta, { webhookUrl: "https://hooks.example.com/x" }, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/x");
    expect(JSON.parse(init.body)).toEqual(alerta);
  });

  it("con correo configurado: hace POST con {to, subject, alert}", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchMoneyAlert(
      alerta,
      { emailTo: "ops@hotel.com", emailWebhookUrl: "https://relay.example.com/correo" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://relay.example.com/correo");
    const body = JSON.parse(init.body);
    expect(body.to).toBe("ops@hotel.com");
    expect(body.alert).toEqual(alerta);
  });

  it("con ambos destinos configurados: entrega a los dos", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchMoneyAlert(
      alerta,
      { webhookUrl: "https://hooks.example.com/x", emailTo: "ops@hotel.com", emailWebhookUrl: "https://relay.example.com/correo" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("un webhook caído/con error NUNCA lanza -- se loguea y se resuelve igual", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const logger = { error: vi.fn() };
    await expect(
      dispatchMoneyAlert(alerta, { webhookUrl: "https://hooks.example.com/x" }, { fetchFn: fetchFn as unknown as typeof fetch, logger }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("una respuesta HTTP no-ok del webhook también se loguea, sin lanzar", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const logger = { error: vi.fn() };
    await dispatchMoneyAlert(alerta, { webhookUrl: "https://hooks.example.com/x" }, { fetchFn: fetchFn as unknown as typeof fetch, logger });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
