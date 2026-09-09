// REQ-HUE-024 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe registrar y
// consultar un consent ledger multi-país antes de cualquier comunicación outbound de
// marketing/upsell." Unit puro (sin BD) de
// `packages/domain-hotel/src/consentLedger.ts`: (1) derivación de jurisdicción por
// prefijo E.164, incluyendo formatos sucios y casos desconocidos, (2) anotación del
// ledger, (3) filtrado por jurisdicción/tipo, (4) resumen agregado. El escenario
// end-to-end contra Postgres real (registrar vía HTTP, consultar el ledger, y el envío
// de marketing bloqueado/desbloqueado según ese registro) vive en
// `tests/integration/api/consentimiento.spec.ts` y
// `tests/adversarial/consent-ledger.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  annotateConsentLedger,
  filterConsentLedger,
  resolveConsentJurisdiction,
  summarizeConsentLedger,
  type ConsentLedgerRow,
} from "@atiende-hoteles/domain-hotel";

describe("resolveConsentJurisdiction (REQ-HUE-024)", () => {
  it("reconoce México", () => {
    expect(resolveConsentJurisdiction("+528111234567")).toBe("MX");
  });

  it("reconoce EE. UU./Canadá", () => {
    expect(resolveConsentJurisdiction("+14155551234")).toBe("US_CA");
  });

  it("reconoce España, Colombia, Argentina, Brasil", () => {
    expect(resolveConsentJurisdiction("+34911234567")).toBe("ES");
    expect(resolveConsentJurisdiction("+573001234567")).toBe("CO");
    expect(resolveConsentJurisdiction("+541123456789")).toBe("AR");
    expect(resolveConsentJurisdiction("+5511987654321")).toBe("BR");
  });

  it("tolera formato sucio (espacios, guiones, paréntesis, sin '+')", () => {
    expect(resolveConsentJurisdiction("52 811 123 4567")).toBe("MX");
    expect(resolveConsentJurisdiction("+52-811-123-4567")).toBe("MX");
    expect(resolveConsentJurisdiction("(52) 811 123 4567")).toBe("MX");
  });

  it("un prefijo E.164 válido pero no catalogado cae en OTRA, nunca se descarta", () => {
    expect(resolveConsentJurisdiction("+81312345678")).toBe("OTRA"); // Japón, no catalogado
  });

  it("teléfono vacío/null/formato irreconocible cae en DESCONOCIDA, nunca lanza", () => {
    expect(resolveConsentJurisdiction(null)).toBe("DESCONOCIDA");
    expect(resolveConsentJurisdiction(undefined)).toBe("DESCONOCIDA");
    expect(resolveConsentJurisdiction("")).toBe("DESCONOCIDA");
    expect(resolveConsentJurisdiction("no-es-un-telefono")).toBe("DESCONOCIDA");
    expect(resolveConsentJurisdiction("123")).toBe("DESCONOCIDA"); // demasiado corto
  });
});

function row(overrides: Partial<ConsentLedgerRow>): ConsentLedgerRow {
  return {
    id: "id-1",
    guestId: "guest-1",
    guestPhone: "+528111234567",
    channel: "whatsapp",
    consentKind: "marketing",
    avisoVersion: "v1",
    granted: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("annotateConsentLedger / filterConsentLedger / summarizeConsentLedger (REQ-HUE-024)", () => {
  it("anota cada fila con la jurisdicción derivada de su teléfono", () => {
    const anotado = annotateConsentLedger([
      row({ id: "mx-1", guestPhone: "+528111234567" }),
      row({ id: "us-1", guestPhone: "+14155551234" }),
      row({ id: "sin-tel", guestPhone: null }),
    ]);
    expect(anotado.map((e) => [e.id, e.jurisdiction])).toEqual([
      ["mx-1", "MX"],
      ["us-1", "US_CA"],
      ["sin-tel", "DESCONOCIDA"],
    ]);
  });

  it("filtra por jurisdicción y por tipo de consentimiento, ambos opcionales", () => {
    const anotado = annotateConsentLedger([
      row({ id: "mx-marketing", guestPhone: "+528111234567", consentKind: "marketing" }),
      row({ id: "mx-datos", guestPhone: "+528111234567", consentKind: "tratamiento_datos" }),
      row({ id: "us-marketing", guestPhone: "+14155551234", consentKind: "marketing" }),
    ]);

    expect(filterConsentLedger(anotado, { jurisdiction: "MX" }).map((e) => e.id).sort()).toEqual([
      "mx-datos",
      "mx-marketing",
    ]);
    expect(filterConsentLedger(anotado, { consentKind: "marketing" }).map((e) => e.id).sort()).toEqual([
      "mx-marketing",
      "us-marketing",
    ]);
    expect(filterConsentLedger(anotado, { jurisdiction: "MX", consentKind: "marketing" }).map((e) => e.id)).toEqual([
      "mx-marketing",
    ]);
    expect(filterConsentLedger(anotado, { jurisdiction: "ES" })).toEqual([]);
  });

  it("resume otorgados vs. revocados por (jurisdicción, tipo)", () => {
    const anotado = annotateConsentLedger([
      row({ id: "1", guestPhone: "+528111234567", consentKind: "marketing", granted: true }),
      row({ id: "2", guestPhone: "+528111234568", consentKind: "marketing", granted: true }),
      row({ id: "3", guestPhone: "+528111234569", consentKind: "marketing", granted: false }),
      row({ id: "4", guestPhone: "+14155551234", consentKind: "marketing", granted: true }),
    ]);
    const resumen = summarizeConsentLedger(anotado);
    expect(resumen).toEqual([
      { jurisdiction: "MX", consentKind: "marketing", granted: 2, revoked: 1 },
      { jurisdiction: "US_CA", consentKind: "marketing", granted: 1, revoked: 0 },
    ]);
  });
});
