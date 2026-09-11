/**
 * REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
 * alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
 * multilingües, y numeración física única por ubicación codificada en el QR."
 * Módulo de dominio PURO (mismo principio que `fnbAllergyGuard.ts`/`folioEngine.ts`):
 * ninguna función de aquí toca I/O -- `apps/api/src/routes/menuQr.ts` es quien lee/
 * escribe `menu_item`/`menu_qr_location` y decide cuándo llamar estas funciones.
 *
 * Tres responsabilidades:
 *   1. `buildLocationCode`: convierte (hotel, tipo de ubicación, numeración física) en
 *      el `location_code` que el QR impreso codifica -- determinístico, así que la
 *      MISMA ubicación siempre produce el MISMO código (idempotente ante reintentos de
 *      registro), y dos ubicaciones distintas (distinto tipo o distinto número) SIEMPRE
 *      producen un código distinto -- la garantía de fondo bajo concurrencia real vive
 *      en el índice único de la migración 0153, esta función es la razón por la que esa
 *      garantía nunca debería siquiera activarse en operación normal.
 *   2. `resolveMenuForGuest`: el motor de reglas de negocio de "qué ve y qué paga cada
 *      tipo de huésped" (todo-incluido / day-pass / ninguno) -- la pieza que el REQ
 *      llama "reglas de all-inclusive/day-pass...aplicadas".
 *   3. `translateAllergen`/`ALLERGEN_LABELS`: la traducción multilingüe de alérgenos
 *      que el REQ exige ("alérgenos multilingües") -- catálogo cerrado, nunca texto
 *      libre por idioma capturado a mano (evita que un hotel traduzca "gluten" distinto
 *      en cada platillo).
 */

// -----------------------------------------------------------------------------
// Ubicaciones físicas del QR
// -----------------------------------------------------------------------------

/** Los 5 tipos de superficie física donde el REQ exige que el menú QR esté disponible
 *  -- catálogo cerrado, igual que `location_type` en la migración 0153. */
export const LOCATION_TYPES = ["habitacion", "alberca", "camastro", "playa", "mesa"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export function isLocationType(value: string): value is LocationType {
  return (LOCATION_TYPES as readonly string[]).includes(value);
}

// Prefijo corto y legible por tipo -- lo que un staff ve impreso junto al QR físico
// (ej. "MSA-0012" en la tarjeta de la mesa 12), no un identificador interno opaco.
const LOCATION_TYPE_PREFIX: Record<LocationType, string> = {
  habitacion: "HAB",
  alberca: "ALB",
  camastro: "CAM",
  playa: "PLY",
  mesa: "MSA",
};

export class InvalidPhysicalNumberError extends Error {
  constructor(physicalNumber: number) {
    super(`numeracion_fisica_invalida: "${physicalNumber}" debe ser un entero positivo.`);
    this.name = "InvalidPhysicalNumberError";
  }
}

/**
 * Construye el `location_code` que un QR físico codifica, a partir de la ubicación
 * real. Determinístico y sin I/O: NO consulta la base de datos ni verifica unicidad
 * (esa garantía es responsabilidad del índice único `menu_qr_location(location_code)`,
 * migración 0153) -- esta función solo define la REGLA de cómo se deriva el código.
 *
 * Incluye un fragmento del `hotelId` (primeros 6 caracteres hex, sin guiones) para que
 * el código sea único incluso ENTRE hoteles distintos: la ruta pública `/menu/:codigo`
 * (REQ-AB-001) resuelve el hotel a partir del código sin que el huésped lo aporte, así
 * que dos hoteles con, por ejemplo, ambos una "mesa 12" nunca deben colisionar.
 */
export function buildLocationCode(hotelId: string, locationType: LocationType, physicalNumber: number): string {
  if (!Number.isInteger(physicalNumber) || physicalNumber <= 0) {
    throw new InvalidPhysicalNumberError(physicalNumber);
  }
  const hotelShort = hotelId.replace(/-/g, "").slice(0, 6).toUpperCase();
  const prefix = LOCATION_TYPE_PREFIX[locationType];
  const padded = String(physicalNumber).padStart(4, "0");
  return `${hotelShort}-${prefix}-${padded}`;
}

/** URL que el QR físico codifica de verdad (lo que una cámara de celular decodifica) --
 *  simple concatenación determinística, sin I/O; `baseUrl` es la URL pública del
 *  frontend de huéspedes (ej. `https://app.atiende-hoteles.com`), configurada por
 *  ambiente, nunca hardcodeada aquí. */
export function buildMenuQrTargetUrl(baseUrl: string, locationCode: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/menu/${locationCode}`;
}

// -----------------------------------------------------------------------------
// Alérgenos multilingües
// -----------------------------------------------------------------------------

/** Catálogo cerrado de alérgenos -- mismo conjunto que el `check` de
 *  `menu_item.allergens` en la migración 0153 (NOM-051 + los alérgenos mayores UE,
 *  acotado a los que de verdad aparecen en cocina de hotel). */
export const ALLERGEN_CODES = [
  "gluten",
  "lactosa",
  "huevo",
  "mariscos",
  "pescado",
  "cacahuate",
  "frutos_secos",
  "soya",
  "sesamo",
  "sulfitos",
] as const;
export type AllergenCode = (typeof ALLERGEN_CODES)[number];

export const SUPPORTED_MENU_LANGUAGES = ["es", "en", "fr"] as const;
export type MenuLanguage = (typeof SUPPORTED_MENU_LANGUAGES)[number];

/** Traducción de cada alérgeno a los 3 idiomas soportados. Único lugar del sistema
 *  donde vive esta traducción -- ni la API ni el frontend deben duplicarla. */
export const ALLERGEN_LABELS: Record<AllergenCode, Record<MenuLanguage, string>> = {
  gluten: { es: "Gluten", en: "Gluten", fr: "Gluten" },
  lactosa: { es: "Lácteos", en: "Dairy", fr: "Lait" },
  huevo: { es: "Huevo", en: "Egg", fr: "Œuf" },
  mariscos: { es: "Mariscos", en: "Shellfish", fr: "Fruits de mer" },
  pescado: { es: "Pescado", en: "Fish", fr: "Poisson" },
  cacahuate: { es: "Cacahuate", en: "Peanuts", fr: "Arachide" },
  frutos_secos: { es: "Frutos secos", en: "Tree nuts", fr: "Fruits à coque" },
  soya: { es: "Soya", en: "Soy", fr: "Soja" },
  sesamo: { es: "Ajonjolí", en: "Sesame", fr: "Sésame" },
  sulfitos: { es: "Sulfitos", en: "Sulphites", fr: "Sulfites" },
};

/** Traduce un alérgeno a `lang` -- si `lang` no está soportado, cae a español (nunca
 *  al código crudo: un huésped nunca debe leer "frutos_secos" en la carta). */
export function translateAllergen(code: AllergenCode, lang: MenuLanguage): string {
  return ALLERGEN_LABELS[code][lang] ?? ALLERGEN_LABELS[code].es;
}

// -----------------------------------------------------------------------------
// Reglas de all-inclusive / day-pass
// -----------------------------------------------------------------------------

/** El tipo de tarifa del huésped que está viendo el menú -- determina qué platillos
 *  ve y cuánto paga por cada uno. "ninguno" es el huésped/comensal sin plan (ej. un
 *  externo en la mesa del restaurante a la carta): paga siempre el precio de lista. */
export type FareContext = "all_inclusive" | "day_pass" | "ninguno";

export interface MenuItemCatalog {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly videoUrl: string;
  readonly price: number;
  readonly allInclusiveIncluded: boolean;
  readonly dayPassAvailable: boolean;
  readonly dayPassSurcharge: number;
  readonly allergens: readonly AllergenCode[];
}

export interface ResolvedAllergen {
  readonly codigo: AllergenCode;
  readonly etiqueta: string;
}

export interface ResolvedMenuItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly videoUrl: string;
  /** Lo que ESTE huésped paga por este platillo, ya con la regla de su tarifa
   *  aplicada -- nunca el precio de lista crudo si el huésped tiene un plan que lo
   *  cambia. */
  readonly precioAPagar: number;
  readonly incluidoEnPlan: boolean;
  readonly alergenos: readonly ResolvedAllergen[];
}

/**
 * Aplica las reglas de all-inclusive/day-pass al catálogo crudo y traduce los
 * alérgenos al idioma pedido. Un platillo que el day-pass NO puede pedir
 * (`dayPassAvailable=false`) se OMITE del resultado -- no se lista "marcado como no
 * disponible": el REQ pide que las reglas se "apliquen", no solo se declaren, y un
 * huésped de day-pass nunca debe ver un platillo que después, al pedirlo, se le niegue.
 */
export function resolveMenuForGuest(
  items: readonly MenuItemCatalog[],
  fareContext: FareContext,
  lang: MenuLanguage,
): ResolvedMenuItem[] {
  const resolved: ResolvedMenuItem[] = [];

  for (const item of items) {
    if (fareContext === "day_pass" && !item.dayPassAvailable) continue;

    let precioAPagar = item.price;
    let incluidoEnPlan = false;
    if (fareContext === "all_inclusive" && item.allInclusiveIncluded) {
      precioAPagar = 0;
      incluidoEnPlan = true;
    } else if (fareContext === "day_pass") {
      precioAPagar = item.price + item.dayPassSurcharge;
    }

    resolved.push({
      id: item.id,
      name: item.name,
      description: item.description,
      videoUrl: item.videoUrl,
      precioAPagar,
      incluidoEnPlan,
      alergenos: item.allergens.map((codigo) => ({ codigo, etiqueta: translateAllergen(codigo, lang) })),
    });
  }

  return resolved;
}
