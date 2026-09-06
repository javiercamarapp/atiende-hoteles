// Contabilidad de costo por modelo real (patron `costoPorModelo` de Likida §2.6): la
// tabla de precios es datos configurables, nunca un numero incrustado en el runner.

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

/**
 * Precios de lista oficiales de Anthropic (USD por millon de tokens) vigentes al
 * construir este paquete (fuente: skill claude-api, tabla cacheada 2026-06-24). Son el
 * default de arranque, no un valor fijo: cualquier corrida puede inyectar su propia
 * PricingTable (p.ej. actualizada desde configuracion) sin tocar el AgentRunner.
 */
export const DEFAULT_PRICING: PricingTable = {
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
};

/**
 * batch_nocturno (Opus 5) corre por Batch API con ~50% de descuento sobre precio de
 * lista. Se modela como una tabla alterna en vez de un factor incrustado en el calculo
 * de costo, para que la corrida nocturna declare explicitamente que tabla usa.
 */
export const DEFAULT_BATCH_PRICING: PricingTable = Object.fromEntries(
  Object.entries(DEFAULT_PRICING).map(([model, price]) => [
    model,
    { inputPerMTok: price.inputPerMTok / 2, outputPerMTok: price.outputPerMTok / 2 },
  ]),
);

/** Costo estimado en USD. Un modelo ausente de la tabla cuesta 0 explicitamente (nunca
 * se adivina un precio) — util para modelos de prueba como el FakeProvider. */
export function estimateCostUsd(
  pricing: PricingTable,
  modelSlug: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = pricing[modelSlug];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
}
