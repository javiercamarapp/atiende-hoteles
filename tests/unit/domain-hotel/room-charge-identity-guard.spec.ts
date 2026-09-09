// REQ-AB-012 (P1/NF): "...y verificar identidad doblemente al cargar a habitación."
import { describe, expect, it } from "vitest";
import {
  evaluateRoomChargeIdentity,
  assertRoomChargeIdentityVerified,
  RoomChargeIdentityBlockedError,
  surnameMatchesGuestName,
  phoneLast4Matches,
} from "@atiende-hoteles/domain-hotel";

describe("surnameMatchesGuestName", () => {
  it("coincide cuando el apellido declarado es una palabra completa del nombre en archivo", () => {
    expect(surnameMatchesGuestName("García", "Juan García Pérez")).toBe(true);
    expect(surnameMatchesGuestName("garcia", "Juan García Pérez")).toBe(true); // sin acento
  });

  it("NO coincide con una subcadena parcial (ana no debe calzar con susana)", () => {
    expect(surnameMatchesGuestName("Ana", "Susana Torres")).toBe(false);
  });

  it("NO coincide si el apellido declarado está vacío", () => {
    expect(surnameMatchesGuestName("   ", "Juan García")).toBe(false);
  });

  it("es insensible a mayúsculas/espacios extra", () => {
    expect(surnameMatchesGuestName("  PÉREZ  ", "juan garcía pérez")).toBe(true);
  });
});

describe("phoneLast4Matches", () => {
  it("coincide si los últimos 4 dígitos son iguales, sin importar el formato", () => {
    expect(phoneLast4Matches("1234", "+52 998 123 1234")).toBe(true);
    expect(phoneLast4Matches("1234", "9981231234")).toBe(true);
  });

  it("NO coincide si los últimos 4 dígitos difieren", () => {
    expect(phoneLast4Matches("9999", "9981231234")).toBe(false);
  });

  it("NO coincide si el reclamo no trae exactamente 4 dígitos", () => {
    expect(phoneLast4Matches("123", "9981231234")).toBe(false);
    expect(phoneLast4Matches("", "9981231234")).toBe(false);
  });
});

describe("evaluateRoomChargeIdentity", () => {
  const claimCorrecto = { statedSurname: "García", statedPhoneLast4: "1234" };
  const onFileCompleto = { guestFullName: "Juan García Pérez", guestPhone: "9981231234" };

  it("verifica cuando ambos reclamos coinciden contra el huésped en archivo", () => {
    const result = evaluateRoomChargeIdentity({ claim: claimCorrecto, onFile: onFileCompleto, overrideAuthorizedByAdmin: false });
    expect(result).toEqual({ verified: true, viaAdminOverride: false, blockedReason: null });
  });

  it("bloquea si el apellido NO coincide, incluso con autorización administrativa (nunca overridable)", () => {
    const result = evaluateRoomChargeIdentity({
      claim: { statedSurname: "Martínez", statedPhoneLast4: "1234" },
      onFile: onFileCompleto,
      overrideAuthorizedByAdmin: true,
    });
    expect(result.verified).toBe(false);
    expect(result.blockedReason).toBe("apellido_no_coincide");
  });

  it("bloquea si el teléfono NO coincide, incluso con autorización administrativa (nunca overridable)", () => {
    const result = evaluateRoomChargeIdentity({
      claim: { statedSurname: "García", statedPhoneLast4: "0000" },
      onFile: onFileCompleto,
      overrideAuthorizedByAdmin: true,
    });
    expect(result.verified).toBe(false);
    expect(result.blockedReason).toBe("telefono_no_coincide");
  });

  it("sin huésped en archivo: bloquea por defecto", () => {
    const result = evaluateRoomChargeIdentity({
      claim: claimCorrecto,
      onFile: { guestFullName: null, guestPhone: null },
      overrideAuthorizedByAdmin: false,
    });
    expect(result).toEqual({ verified: false, viaAdminOverride: false, blockedReason: "sin_huesped_en_archivo" });
  });

  it("sin huésped en archivo: la válvula de escape administrativa SÍ permite continuar", () => {
    const result = evaluateRoomChargeIdentity({
      claim: claimCorrecto,
      onFile: { guestFullName: null, guestPhone: null },
      overrideAuthorizedByAdmin: true,
    });
    expect(result).toEqual({ verified: true, viaAdminOverride: true, blockedReason: null });
  });

  it("huésped en archivo sin teléfono capturado: bloquea por defecto aunque el nombre calce", () => {
    const result = evaluateRoomChargeIdentity({
      claim: claimCorrecto,
      onFile: { guestFullName: "Juan García Pérez", guestPhone: null },
      overrideAuthorizedByAdmin: false,
    });
    expect(result).toEqual({ verified: false, viaAdminOverride: false, blockedReason: "sin_telefono_en_archivo" });
  });

  it("huésped sin teléfono capturado: la válvula de escape administrativa SÍ permite continuar", () => {
    const result = evaluateRoomChargeIdentity({
      claim: claimCorrecto,
      onFile: { guestFullName: "Juan García Pérez", guestPhone: null },
      overrideAuthorizedByAdmin: true,
    });
    expect(result).toEqual({ verified: true, viaAdminOverride: true, blockedReason: null });
  });
});

describe("assertRoomChargeIdentityVerified", () => {
  it("no truena cuando la verificación pasa", () => {
    expect(() =>
      assertRoomChargeIdentityVerified({
        claim: { statedSurname: "García", statedPhoneLast4: "1234" },
        onFile: { guestFullName: "Juan García Pérez", guestPhone: "9981231234" },
        overrideAuthorizedByAdmin: false,
      }),
    ).not.toThrow();
  });

  it("lanza RoomChargeIdentityBlockedError con el código esperado cuando la verificación falla", () => {
    try {
      assertRoomChargeIdentityVerified({
        claim: { statedSurname: "Martínez", statedPhoneLast4: "1234" },
        onFile: { guestFullName: "Juan García Pérez", guestPhone: "9981231234" },
        overrideAuthorizedByAdmin: false,
      });
      expect.fail("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomChargeIdentityBlockedError);
      expect((err as RoomChargeIdentityBlockedError).code).toBe("fnb_cargo_habitacion_identidad_no_verificada");
      expect((err as RoomChargeIdentityBlockedError).reason).toBe("apellido_no_coincide");
    }
  });
});
