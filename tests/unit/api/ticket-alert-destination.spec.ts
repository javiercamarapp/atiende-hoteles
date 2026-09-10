// REQ-HUE-014 (ampliación "notificación activa"): fija el contrato de
// apps/api/src/lib/ticketAlertDispatch.ts -- mismo shape que
// tests/unit/api/money-alert-destination.spec.ts, pero para las variables de entorno
// PROPIAS de tickets (con fallback a MONEY_ALERT_* cuando no están configuradas). La
// entrega real (webhook/correo, nunca lanza) ya está probada exhaustivamente contra
// `dispatchMoneyAlert` en money-alert-destination.spec.ts -- `dispatchTicketAlert` es
// literalmente ese mismo símbolo reexportado, así que aquí solo se fija la resolución
// del destino, no se repite la prueba de entrega.
import { describe, expect, it } from "vitest";
import {
  dispatchTicketAlert,
  hasTicketAlertDestination,
  resolveTicketAlertDestination,
} from "../../../apps/api/src/lib/ticketAlertDispatch.ts";
import { dispatchMoneyAlert } from "../../../apps/api/src/lib/moneyAlert.ts";

describe("resolveTicketAlertDestination / hasTicketAlertDestination", () => {
  it("sin ninguna variable de entorno: sin destino", () => {
    expect(hasTicketAlertDestination(resolveTicketAlertDestination({} as NodeJS.ProcessEnv))).toBe(false);
  });

  it("con TICKET_ALERT_WEBHOOK_URL propio: hay destino, usa ESE valor (no el de MONEY_ALERT)", () => {
    const config = resolveTicketAlertDestination({
      TICKET_ALERT_WEBHOOK_URL: "https://hooks.example.com/tickets",
      MONEY_ALERT_WEBHOOK_URL: "https://hooks.example.com/dinero",
    } as NodeJS.ProcessEnv);
    expect(config.webhookUrl).toBe("https://hooks.example.com/tickets");
    expect(hasTicketAlertDestination(config)).toBe(true);
  });

  it("sin TICKET_ALERT_WEBHOOK_URL pero con MONEY_ALERT_WEBHOOK_URL: cae al fallback genérico", () => {
    const config = resolveTicketAlertDestination({
      MONEY_ALERT_WEBHOOK_URL: "https://hooks.example.com/dinero",
    } as NodeJS.ProcessEnv);
    expect(config.webhookUrl).toBe("https://hooks.example.com/dinero");
    expect(hasTicketAlertDestination(config)).toBe(true);
  });

  it("con solo TICKET_ALERT_EMAIL_TO (sin el webhook de correo, ni propio ni de fallback): NO cuenta como destino", () => {
    const config = resolveTicketAlertDestination({ TICKET_ALERT_EMAIL_TO: "gerencia@hotel.com" } as NodeJS.ProcessEnv);
    expect(hasTicketAlertDestination(config)).toBe(false);
  });

  it("con TICKET_ALERT_EMAIL_TO + TICKET_ALERT_EMAIL_WEBHOOK_URL: hay destino", () => {
    const config = resolveTicketAlertDestination({
      TICKET_ALERT_EMAIL_TO: "gerencia@hotel.com",
      TICKET_ALERT_EMAIL_WEBHOOK_URL: "https://relay.example.com/correo",
    } as NodeJS.ProcessEnv);
    expect(hasTicketAlertDestination(config)).toBe(true);
  });
});

describe("dispatchTicketAlert", () => {
  it("es literalmente dispatchMoneyAlert reexportado (mismo mecanismo de entrega genérico, sin duplicar lógica)", () => {
    expect(dispatchTicketAlert).toBe(dispatchMoneyAlert);
  });
});
