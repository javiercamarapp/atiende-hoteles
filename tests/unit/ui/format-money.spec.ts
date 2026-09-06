// auditoria-2/frontend [BAJO] · "Sin formateador de moneda compartido" -- ninguna
// pantalla usaba separador de miles. Fija el contrato de `formatMoney` (packages/ui).
import { describe, expect, it } from "vitest";
import { formatMoney } from "../../../packages/ui/src/lib/formatMoney.ts";

describe("formatMoney", () => {
  it("agrega separador de miles con 2 decimales por defecto", () => {
    expect(formatMoney(12500)).toBe("12,500.00");
  });

  it("respeta decimales=0 (ej. ADR/RevPAR mostrados sin centavos)", () => {
    expect(formatMoney(12500, 0)).toBe("12,500");
  });

  it("un monto pequeño (sin miles) se ve igual que antes, solo con 2 decimales", () => {
    expect(formatMoney(297.5)).toBe("297.50");
  });

  it("nunca redondea el dinero -- solo formatea el número que el backend ya calculó", () => {
    expect(formatMoney(1234567.89)).toBe("1,234,567.89");
  });

  it("cero se formatea como 0.00, no como cadena vacía ni null (REQ-UX-002: el llamador decide si mostrar guion)", () => {
    expect(formatMoney(0)).toBe("0.00");
  });
});
