/** Reconstruye el payload firmado que Stripe realmente firma: `${timestamp}.${rawBody}`.
 *  Idéntico al de `packages/mcp-servers/payments` -- duplicado a propósito (no se crea
 *  una dependencia cruzada entre paquetes de dominio distinto solo por 2 líneas). */
export function stripeSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}
