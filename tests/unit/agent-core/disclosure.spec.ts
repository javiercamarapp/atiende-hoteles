// REQ-HUE-006/GOB-034 — unidad del disclosure engine (agent-core disclosure.ts):
// texto reutilizado desde AGENT_DEFINITIONS (fuente única, ver comentario de archivo),
// respuesta fija a "¿eres humano?" y su detector determinista. Cobertura de flujo real
// (webhook de WhatsApp) en tests/adversarial/disclosure-ia.spec.ts.
import { describe, expect, it } from "vitest";
import {
  AGENT_DEFINITIONS,
  RECEPCION_VIRTUAL,
  esPreguntaSiEsHumano,
  RESPUESTA_FIJA_ES_HUMANO,
  WHATSAPP_DISCLOSURE_MESSAGE,
} from "@atiende-hoteles/agent-core";

describe("disclosure.ts (REQ-HUE-006/GOB-034)", () => {
  it("WHATSAPP_DISCLOSURE_MESSAGE es EXACTAMENTE AGENT_DEFINITIONS.recepcion_virtual.disclosureMessage -- una sola fuente de verdad", () => {
    expect(WHATSAPP_DISCLOSURE_MESSAGE).toBe(AGENT_DEFINITIONS[RECEPCION_VIRTUAL]!.disclosureMessage);
    expect(WHATSAPP_DISCLOSURE_MESSAGE.length).toBeGreaterThan(0);
  });

  it("RESPUESTA_FIJA_ES_HUMANO es un texto fijo no vacío", () => {
    expect(RESPUESTA_FIJA_ES_HUMANO.length).toBeGreaterThan(0);
  });

  it("esPreguntaSiEsHumano: reconoce variantes de la pregunta, insensible a mayúsculas/acentos/signos", () => {
    expect(esPreguntaSiEsHumano("¿Eres humano?")).toBe(true);
    expect(esPreguntaSiEsHumano("eres humano")).toBe(true);
    expect(esPreguntaSiEsHumano("ERES HUMANO")).toBe(true);
    expect(esPreguntaSiEsHumano("¿eres una persona?")).toBe(true);
    expect(esPreguntaSiEsHumano("eres un robot?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿eres un bot?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿Eres tú una IA?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿hablo con un humano?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿hablo con una persona real?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿Es esto un bot?")).toBe(true);
    expect(esPreguntaSiEsHumano("¿es esto un robot?")).toBe(true);
  });

  it("esPreguntaSiEsHumano: false para texto ajeno, vacío o ausente", () => {
    expect(esPreguntaSiEsHumano("¿A qué hora es el check-out?")).toBe(false);
    expect(esPreguntaSiEsHumano("quiero reservar una habitación")).toBe(false);
    expect(esPreguntaSiEsHumano("")).toBe(false);
    expect(esPreguntaSiEsHumano(null)).toBe(false);
    expect(esPreguntaSiEsHumano(undefined)).toBe(false);
    // No debe disparar por una subcadena "es"/"ia" dentro de otra palabra.
    expect(esPreguntaSiEsHumano("esta habitación tiene vista al mar")).toBe(false);
    expect(esPreguntaSiEsHumano("el diario está en la mesa")).toBe(false);
  });
});
