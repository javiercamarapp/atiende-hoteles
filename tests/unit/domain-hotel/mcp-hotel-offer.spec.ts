// REQ-RES-021: "servidor MCP expone disponibilidad/tarifa/reserva con datos
// estructurados schema.org Hotel/Offer" -- este archivo prueba SOLO la parte pura
// (mapeo determinista, sin I/O) que `@atiende-hoteles/mcp-hotel` usa para construir la
// respuesta de la herramienta `buscar_disponibilidad`. El contrato de integración
// completo (servidor MCP real + embedded-postgres) vive en
// tests/integration/contracts/mcp-hotel/schema.spec.ts.
import { describe, expect, it } from "vitest";
import { buildHotelAvailabilityJsonLd, hotelAvailabilityJsonLdSchema } from "@atiende-hoteles/domain-hotel";

const BASE = {
  hotelId: "hotel-1",
  hotelName: "Hotel Ejemplo",
  checkInDate: "2026-10-01",
  checkOutDate: "2026-10-03",
};

describe("buildHotelAvailabilityJsonLd (REQ-RES-021)", () => {
  it("produce un Hotel con un Offer InStock cuando hay disponibilidad y tarifa", () => {
    const jsonLd = buildHotelAvailabilityJsonLd({
      ...BASE,
      roomTypes: [
        { roomTypeId: "rt-1", roomTypeName: "Doble", disponibles: 3, netAmount: 2400, currency: "MXN", reason: null },
      ],
    });
    expect(() => hotelAvailabilityJsonLdSchema.parse(jsonLd)).not.toThrow();
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("Hotel");
    expect(jsonLd.makesOffer).toHaveLength(1);
    const offer = jsonLd.makesOffer[0]!;
    expect(offer.availability).toBe("https://schema.org/InStock");
    expect(offer.priceSpecification).toEqual({ "@type": "PriceSpecification", price: 2400, priceCurrency: "MXN" });
    expect(offer.itemOffered).toEqual({ "@type": "Room", name: "Doble" });
  });

  it("marca SoldOut y omite priceSpecification cuando disponibles=0, sin inventar un precio", () => {
    const jsonLd = buildHotelAvailabilityJsonLd({
      ...BASE,
      roomTypes: [
        { roomTypeId: "rt-1", roomTypeName: "Doble", disponibles: 0, netAmount: null, currency: "MXN", reason: "sin_disponibilidad" },
      ],
    });
    expect(() => hotelAvailabilityJsonLdSchema.parse(jsonLd)).not.toThrow();
    const offer = jsonLd.makesOffer[0]!;
    expect(offer.availability).toBe("https://schema.org/SoldOut");
    expect(offer.priceSpecification).toBeUndefined();
    expect(offer.description).toBe("Sin habitaciones disponibles para esa estadía.");
  });

  it("marca SoldOut cuando hay inventario pero la estadía no cumple min-stay/CTA/CTD (netAmount null)", () => {
    const jsonLd = buildHotelAvailabilityJsonLd({
      ...BASE,
      roomTypes: [
        { roomTypeId: "rt-1", roomTypeName: "Suite", disponibles: 5, netAmount: null, currency: "MXN", reason: "estadia_minima_no_alcanzada" },
      ],
    });
    const offer = jsonLd.makesOffer[0]!;
    expect(offer.availability).toBe("https://schema.org/SoldOut");
    expect(offer.priceSpecification).toBeUndefined();
  });

  it("con varios tipos de habitación produce un Offer por cada uno, en el mismo orden", () => {
    const jsonLd = buildHotelAvailabilityJsonLd({
      ...BASE,
      roomTypes: [
        { roomTypeId: "rt-1", roomTypeName: "Doble", disponibles: 2, netAmount: 2000, currency: "MXN", reason: null },
        { roomTypeId: "rt-2", roomTypeName: "Suite", disponibles: 0, netAmount: null, currency: "MXN", reason: "sin_disponibilidad" },
      ],
    });
    expect(jsonLd.makesOffer.map((o) => o["@id"])).toEqual(["rt-1", "rt-2"]);
  });

  it("rechaza (falla el schema) una entrada InStock con precio negativo -- nunca un precio inválido pasa silenciosamente", () => {
    const invalid = {
      "@context": "https://schema.org",
      "@type": "Hotel",
      "@id": "hotel-1",
      name: "Hotel Ejemplo",
      makesOffer: [
        {
          "@type": "Offer",
          "@id": "rt-1",
          name: "Doble",
          availability: "https://schema.org/InStock",
          availabilityStarts: "2026-10-01",
          availabilityEnds: "2026-10-03",
          priceSpecification: { "@type": "PriceSpecification", price: -10, priceCurrency: "MXN" },
          itemOffered: { "@type": "Room", name: "Doble" },
        },
      ],
    };
    expect(() => hotelAvailabilityJsonLdSchema.parse(invalid)).toThrow();
  });
});
