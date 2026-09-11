// REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
// alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
// multilingües, y numeración física única por ubicación codificada en el QR."
import { describe, expect, it } from "vitest";
import {
  ALLERGEN_CODES,
  InvalidPhysicalNumberError,
  LOCATION_TYPES,
  buildLocationCode,
  buildMenuQrTargetUrl,
  isLocationType,
  resolveMenuForGuest,
  translateAllergen,
  type MenuItemCatalog,
} from "@atiende-hoteles/domain-hotel";

describe("LOCATION_TYPES/isLocationType", () => {
  it("expone exactamente los 5 tipos de ubicación que el REQ exige", () => {
    expect([...LOCATION_TYPES].sort()).toEqual(["alberca", "camastro", "habitacion", "mesa", "playa"]);
  });

  it("isLocationType distingue valores válidos de basura", () => {
    for (const t of LOCATION_TYPES) expect(isLocationType(t)).toBe(true);
    expect(isLocationType("bar")).toBe(false);
    expect(isLocationType("")).toBe(false);
  });
});

describe("buildLocationCode: numeración física única por ubicación codificada en el QR", () => {
  const hotelA = "11111111-2222-3333-4444-555555555555";
  const hotelB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("es determinístico: la MISMA ubicación siempre produce el MISMO código", () => {
    const code1 = buildLocationCode(hotelA, "mesa", 12);
    const code2 = buildLocationCode(hotelA, "mesa", 12);
    expect(code1).toBe(code2);
  });

  it("verificado: 2 QR distintos (distinto número, mismo tipo) -> 2 location_code distintos", () => {
    const mesa12 = buildLocationCode(hotelA, "mesa", 12);
    const mesa13 = buildLocationCode(hotelA, "mesa", 13);
    expect(mesa12).not.toBe(mesa13);
  });

  it("verificado: 2 QR distintos (mismo número, distinto tipo) -> 2 location_code distintos", () => {
    const mesa12 = buildLocationCode(hotelA, "mesa", 12);
    const camastro12 = buildLocationCode(hotelA, "camastro", 12);
    expect(mesa12).not.toBe(camastro12);
  });

  it("verificado: 2 QR distintos (mismo tipo/número, distinto hotel) -> 2 location_code distintos", () => {
    const mesaHotelA = buildLocationCode(hotelA, "mesa", 12);
    const mesaHotelB = buildLocationCode(hotelB, "mesa", 12);
    expect(mesaHotelA).not.toBe(mesaHotelB);
  });

  it("codifica la numeración física de forma legible (padded a 4 dígitos)", () => {
    expect(buildLocationCode(hotelA, "habitacion", 7)).toMatch(/HAB-0007$/);
    expect(buildLocationCode(hotelA, "playa", 231)).toMatch(/PLY-0231$/);
  });

  it("rechaza numeración física inválida (cero, negativa, no entera)", () => {
    expect(() => buildLocationCode(hotelA, "mesa", 0)).toThrow(InvalidPhysicalNumberError);
    expect(() => buildLocationCode(hotelA, "mesa", -1)).toThrow(InvalidPhysicalNumberError);
    expect(() => buildLocationCode(hotelA, "mesa", 1.5)).toThrow(InvalidPhysicalNumberError);
  });
});

describe("buildMenuQrTargetUrl", () => {
  it("concatena la URL pública y el location_code sin doble slash", () => {
    expect(buildMenuQrTargetUrl("https://app.demo.com/", "ABC123-MSA-0012")).toBe(
      "https://app.demo.com/menu/ABC123-MSA-0012",
    );
    expect(buildMenuQrTargetUrl("https://app.demo.com", "ABC123-MSA-0012")).toBe(
      "https://app.demo.com/menu/ABC123-MSA-0012",
    );
  });
});

describe("translateAllergen: alérgenos multilingües", () => {
  it("traduce cada alérgeno del catálogo a los 3 idiomas soportados sin caer al código crudo", () => {
    for (const code of ALLERGEN_CODES) {
      for (const lang of ["es", "en", "fr"] as const) {
        const label = translateAllergen(code, lang);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(code);
      }
    }
  });

  it("gluten/mariscos traducen distinto en cada idioma soportado", () => {
    expect(translateAllergen("gluten", "es")).toBe("Gluten");
    expect(translateAllergen("gluten", "en")).toBe("Gluten");
    expect(translateAllergen("mariscos", "es")).toBe("Mariscos");
    expect(translateAllergen("mariscos", "en")).toBe("Shellfish");
    expect(translateAllergen("mariscos", "fr")).toBe("Fruits de mer");
  });
});

describe("resolveMenuForGuest: reglas de all-inclusive/day-pass aplicadas", () => {
  const platilloIncluido: MenuItemCatalog = {
    id: "item-incluido",
    name: "Ceviche de la casa",
    description: "Pescado fresco del día",
    videoUrl: "https://cdn.demo.com/ceviche.mp4",
    price: 180,
    allInclusiveIncluded: true,
    dayPassAvailable: true,
    dayPassSurcharge: 40,
    allergens: ["pescado", "mariscos"],
  };
  const platilloNoIncluido: MenuItemCatalog = {
    id: "item-premium",
    name: "Corte premium",
    description: "Corte Angus 300g",
    videoUrl: "https://cdn.demo.com/corte.mp4",
    price: 650,
    allInclusiveIncluded: false,
    dayPassAvailable: false,
    dayPassSurcharge: 0,
    allergens: [],
  };
  const items = [platilloIncluido, platilloNoIncluido];

  it("todo-incluido: el platillo incluido cuesta 0 y queda marcado incluidoEnPlan", () => {
    const resueltos = resolveMenuForGuest(items, "all_inclusive", "es");
    const ceviche = resueltos.find((r) => r.id === "item-incluido")!;
    expect(ceviche.precioAPagar).toBe(0);
    expect(ceviche.incluidoEnPlan).toBe(true);
  });

  it("todo-incluido: un platillo NO incluido se paga a precio de lista completo", () => {
    const resueltos = resolveMenuForGuest(items, "all_inclusive", "es");
    const corte = resueltos.find((r) => r.id === "item-premium")!;
    expect(corte.precioAPagar).toBe(650);
    expect(corte.incluidoEnPlan).toBe(false);
  });

  it("day-pass: paga precio + recargo en el platillo disponible para day-pass", () => {
    const resueltos = resolveMenuForGuest(items, "day_pass", "es");
    const ceviche = resueltos.find((r) => r.id === "item-incluido")!;
    expect(ceviche.precioAPagar).toBe(180 + 40);
    expect(ceviche.incluidoEnPlan).toBe(false);
  });

  it("day-pass: un platillo con dayPassAvailable=false NUNCA aparece en el menú resuelto (caso negativo)", () => {
    const resueltos = resolveMenuForGuest(items, "day_pass", "es");
    expect(resueltos.find((r) => r.id === "item-premium")).toBeUndefined();
    expect(resueltos).toHaveLength(1);
  });

  it("sin plan (a la carta): siempre paga el precio de lista, incluso el platillo 'incluido'", () => {
    const resueltos = resolveMenuForGuest(items, "ninguno", "es");
    const ceviche = resueltos.find((r) => r.id === "item-incluido")!;
    const corte = resueltos.find((r) => r.id === "item-premium")!;
    expect(ceviche.precioAPagar).toBe(180);
    expect(ceviche.incluidoEnPlan).toBe(false);
    expect(corte.precioAPagar).toBe(650);
  });

  it("traduce los alérgenos de cada platillo resuelto al idioma pedido", () => {
    const resueltos = resolveMenuForGuest(items, "ninguno", "en");
    const ceviche = resueltos.find((r) => r.id === "item-incluido")!;
    expect(ceviche.alergenos).toEqual([
      { codigo: "pescado", etiqueta: "Fish" },
      { codigo: "mariscos", etiqueta: "Shellfish" },
    ]);
  });

  it("catálogo vacío devuelve un menú resuelto vacío, nunca truena", () => {
    expect(resolveMenuForGuest([], "all_inclusive", "es")).toEqual([]);
  });
});
