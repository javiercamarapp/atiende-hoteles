// REQ-RES-019 (P2/F): pruebas unitarias de la decisión pura de deduplicación
// (packages/domain-hotel/src/guestContactDedup.ts). La prueba de integración contra
// embedded-postgres real (2 reservas → 1 fila `guest`) vive en
// tests/integration/guests/deduplicacion.spec.ts.
import { describe, expect, it } from "vitest";
import { findGuestDedupeMatch, normalizeGuestName } from "@atiende-hoteles/domain-hotel";

describe("normalizeGuestName", () => {
  it("ignora mayúsculas, acentos y espacios repetidos/extremos", () => {
    expect(normalizeGuestName("María José Pérez")).toBe(normalizeGuestName("maria   jose perez  "));
    expect(normalizeGuestName("MARÍA JOSÉ PÉREZ")).toBe(normalizeGuestName("María José Pérez"));
  });

  it("nombres genuinamente distintos no normalizan igual", () => {
    expect(normalizeGuestName("Juan Pérez")).not.toBe(normalizeGuestName("Juana Pérez"));
  });
});

describe("findGuestDedupeMatch", () => {
  const perfilExistente = { guestId: "guest-1", fullName: "María José Pérez", channels: ["booking_com"] };

  it("fusiona con un perfil existente del MISMO canal y MISMO nombre normalizado (contacto enmascarado distinto irrelevante)", () => {
    const match = findGuestDedupeMatch({ fullName: "MARIA JOSE PEREZ", channel: "booking_com" }, [perfilExistente]);
    expect(match).toBe("guest-1");
  });

  it("caso negativo: NUNCA fusiona por canal 'directo', aunque el nombre normalizado coincida exacto", () => {
    const match = findGuestDedupeMatch({ fullName: "María José Pérez", channel: "directo" }, [perfilExistente]);
    expect(match).toBeNull();
  });

  it("caso negativo: no fusiona si el nombre normalizado no coincide (huésped distinto)", () => {
    const match = findGuestDedupeMatch({ fullName: "Juan Pérez", channel: "booking_com" }, [perfilExistente]);
    expect(match).toBeNull();
  });

  it("caso negativo: no fusiona entre canales distintos aunque el nombre coincida (Booking vs Airbnb)", () => {
    const match = findGuestDedupeMatch({ fullName: "María José Pérez", channel: "airbnb" }, [perfilExistente]);
    expect(match).toBeNull();
  });

  it("caso negativo: nombre vacío/solo espacios nunca fusiona", () => {
    const match = findGuestDedupeMatch({ fullName: "   ", channel: "booking_com" }, [perfilExistente]);
    expect(match).toBeNull();
  });

  it("sin perfiles existentes, nunca fusiona", () => {
    expect(findGuestDedupeMatch({ fullName: "María José Pérez", channel: "booking_com" }, [])).toBeNull();
  });
});
