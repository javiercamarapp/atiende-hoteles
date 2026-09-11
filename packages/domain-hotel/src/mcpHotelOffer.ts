// REQ-RES-021 (BP-021, H06-004/H06-010/H06-011/H06-012/H06-013, H07-038): "el sistema
// debe exponer disponibilidad, tarifa y reserva mediante un servidor MCP y datos
// estructurados (schema.org Hotel/Offer) para que agentes de IA externos puedan
// consultar y reservar". Este módulo es la parte PURA (sin I/O, sin red, sin reloj) de
// ese requisito: da forma schema.org a filas de disponibilidad/tarifa YA calculadas por
// el motor real (`@atiende-hoteles/mcp-hotel`, que sí toca la base de datos) -- ningún
// precio se inventa ni se redondea aquí, solo se formatea el que ya llegó.
//
// H06-010 pide validar contra "el esquema Hotel/Offer" -- `hotelAvailabilityJsonLdSchema`
// (zod) es el contrato formal que un cliente MCP externo (o el propio test de
// contrato, tests/integration/contracts/mcp-hotel/schema.spec.ts) puede usar para
// verificarlo, mismo patrón que `PmsReservation`/`PmsWebhookEvent` en
// `packages/mcp-servers/pms/src/port.ts`.
import { z } from "zod";

export type MoneyAvailability = "https://schema.org/InStock" | "https://schema.org/SoldOut";

export interface RoomTypeAvailabilityInput {
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  /** Habitaciones libres (mínimo del rango, peor caso -- mismo criterio que
   *  `apps/api/src/routes/disponibilidad.ts`). `0` cuando no hay inventario cargado. */
  readonly disponibles: number;
  /** Presente solo cuando la estadía es cotizable (hay tarifa, min-stay/CTA/CTD
   *  cumplidos) -- `null` cuando `reason` explica por qué no. NETO, sin impuestos
   *  (mismo campo que persiste `reservation.total_amount`, ver `quote.ts`). */
  readonly netAmount: number | null;
  readonly currency: string;
  /** Código corto de por qué no es reservable (`sin_tarifa`, `cerrado_a_llegada`,
   *  `cerrado_a_salida`, `estadia_minima_no_alcanzada`, `sin_disponibilidad`) --
   *  `null` cuando sí lo es. */
  readonly reason: string | null;
}

export interface HotelAvailabilityInput {
  readonly hotelId: string;
  readonly hotelName: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly roomTypes: readonly RoomTypeAvailabilityInput[];
}

const offerSchema = z.object({
  "@type": z.literal("Offer"),
  "@id": z.string().min(1),
  name: z.string().min(1),
  availability: z.enum(["https://schema.org/InStock", "https://schema.org/SoldOut"]),
  availabilityStarts: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  availabilityEnds: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  priceSpecification: z
    .object({
      "@type": z.literal("PriceSpecification"),
      price: z.number().nonnegative(),
      priceCurrency: z.string().min(3).max(3),
    })
    .optional(),
  description: z.string().optional(),
  itemOffered: z.object({
    "@type": z.literal("Room"),
    name: z.string().min(1),
  }),
});

/** Contrato formal schema.org Hotel/Offer (H06-010): "las páginas del hotel validan
 *  contra el esquema Hotel/Offer". Un cliente MCP externo (o el test de contrato) hace
 *  `.parse()`/`.safeParse()` de la respuesta de la herramienta `buscar_disponibilidad`
 *  contra este esquema. */
export const hotelAvailabilityJsonLdSchema = z.object({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("Hotel"),
  "@id": z.string().min(1),
  name: z.string().min(1),
  makesOffer: z.array(offerSchema),
});

export type HotelAvailabilityJsonLd = z.infer<typeof hotelAvailabilityJsonLdSchema>;

const REASON_LABEL: Record<string, string> = {
  sin_tarifa: "Sin tarifa configurada para esta estadía.",
  cerrado_a_llegada: "Fecha de llegada cerrada a nuevas llegadas (CTA).",
  cerrado_a_salida: "Fecha de salida cerrada (CTD).",
  estadia_minima_no_alcanzada: "La estadía solicitada no alcanza la estadía mínima de esta tarifa.",
  sin_disponibilidad: "Sin habitaciones disponibles para esa estadía.",
  estadia_invalida: "Rango de fechas inválido.",
};

/**
 * Construye el JSON-LD `Hotel` con un `Offer` por tipo de habitación (H07-038: "el
 * servidor MCP responde correctamente a consultas de disponibilidad, cotización y
 * reserva"). Determinista: misma entrada, misma salida -- ningún LLM ni reloj
 * interviene aquí (REQ-REV-001, mismo principio que `computeQuote`).
 */
export function buildHotelAvailabilityJsonLd(input: HotelAvailabilityInput): HotelAvailabilityJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": input.hotelId,
    name: input.hotelName,
    makesOffer: input.roomTypes.map((rt) => {
      const inStock = rt.disponibles > 0 && rt.netAmount != null && rt.reason == null;
      return {
        "@type": "Offer" as const,
        "@id": rt.roomTypeId,
        name: rt.roomTypeName,
        availability: (inStock ? "https://schema.org/InStock" : "https://schema.org/SoldOut") as MoneyAvailability,
        availabilityStarts: input.checkInDate,
        availabilityEnds: input.checkOutDate,
        ...(inStock
          ? { priceSpecification: { "@type": "PriceSpecification" as const, price: rt.netAmount!, priceCurrency: rt.currency } }
          : {}),
        ...(rt.reason ? { description: REASON_LABEL[rt.reason] ?? rt.reason } : {}),
        itemOffered: { "@type": "Room" as const, name: rt.roomTypeName },
      };
    }),
  };
}
