// REQ-RES-018: "El agente de reservas debe capturar el teléfono/email real del huésped
// cuando la OTA lo enmascara... sin contactar antes por un canal ajeno a la plataforma de
// la OTA." Cubre el CÁLCULO puro (`esContactoEnmascaradoPorOta`/
// `debeBloquearContactoPorCanalAjenoALaOta`) -- la contraparte con I/O real (gate contra
// Postgres real, envío del enlace por el canal 'ota') vive en
// tests/integration/ota/contacto-enmascarado.spec.ts (ubicación exacta que
// docs/ACEPTACION.md prescribe para este REQ).
import { describe, expect, it } from "vitest";
import {
  debeBloquearContactoPorCanalAjenoALaOta,
  esContactoEnmascaradoPorOta,
  type ReservaContactoOtaInput,
} from "@atiende-hoteles/domain-hotel";

describe("esContactoEnmascaradoPorOta (REQ-RES-018)", () => {
  it("channel 'directo' nunca está enmascarado, sin importar el flag", () => {
    expect(esContactoEnmascaradoPorOta({ channel: "directo", guestContactMaskedByOta: true })).toBe(false);
    expect(esContactoEnmascaradoPorOta({ channel: "directo", guestContactMaskedByOta: false })).toBe(false);
  });

  it("channel de OTA + flag true -> enmascarado", () => {
    const input: ReservaContactoOtaInput = { channel: "booking_com", guestContactMaskedByOta: true };
    expect(esContactoEnmascaradoPorOta(input)).toBe(true);
  });

  it("channel de OTA + flag false (ya desenmascarado, p. ej. tras completar check-in online) -> NO bloquea", () => {
    expect(esContactoEnmascaradoPorOta({ channel: "airbnb", guestContactMaskedByOta: false })).toBe(false);
  });

  it("cualquier valor de canal distinto de 'directo' cuenta (no hay lista cerrada de OTAs)", () => {
    expect(esContactoEnmascaradoPorOta({ channel: "expedia", guestContactMaskedByOta: true })).toBe(true);
    expect(esContactoEnmascaradoPorOta({ channel: "agente_ia_externo", guestContactMaskedByOta: true })).toBe(true);
  });
});

describe("debeBloquearContactoPorCanalAjenoALaOta (REQ-RES-018, segunda mitad del criterio)", () => {
  it("es un alias exacto de esContactoEnmascaradoPorOta -- nunca diverge", () => {
    const casos: ReservaContactoOtaInput[] = [
      { channel: "directo", guestContactMaskedByOta: true },
      { channel: "booking_com", guestContactMaskedByOta: true },
      { channel: "booking_com", guestContactMaskedByOta: false },
    ];
    for (const caso of casos) {
      expect(debeBloquearContactoPorCanalAjenoALaOta(caso)).toBe(esContactoEnmascaradoPorOta(caso));
    }
  });
});
