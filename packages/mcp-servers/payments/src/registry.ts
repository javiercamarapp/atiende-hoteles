/**
 * Registro único de conectores de pago (REQ-INT-015/REQ-AGT-018, GOB-027/GOB-059/BP-141:
 * "prohibido `if provider === X` fuera del registro central"). Mismo patrón que
 * `packages/mcp-servers/pms/src/registry.ts` (PMS_CONNECTOR_REGISTRY) -- REQ-INT-015
 * exige que ese patrón de "registro único" no sea exclusivo de PMS, así que este archivo
 * es su homólogo declarativo para pagos: un único lugar que enumera los proveedores
 * soportados, su orden y su estado real, en vez de dejar esa información implícita en
 * `resolvePaymentPort()` (apps/api/src/lib/resolvePaymentPort.ts).
 *
 * Orden de prioridad = mismo orden de selección que `resolvePaymentPort()` documenta
 * (Stripe > Conekta): ese archivo NO bifurca por `provider === "stripe"` -- prueba
 * disponibilidad real de credenciales en ese orden (`stripe.status().available`) -- así
 * que este registro no reemplaza esa lógica de runtime, solo la hace verificable y
 * documentada en un único lugar (mismo rol que PMS_CONNECTOR_REGISTRY: catálogo, no
 * mecanismo de selección).
 *
 * `status` refleja el estado REAL del código de este repo, nunca aspiracional: Stripe y
 * Conekta SÍ tienen adaptador real implementado (`stripe-adapter.ts`/`conekta-adapter.ts`,
 * cada uno con doble de prueba en `fake-payment-adapter.ts`) -- "implementado" aquí
 * significa que el código del adaptador existe y está probado contra su contrato
 * documentado, NO que haya credenciales reales configuradas en este entorno (ese es un
 * eje distinto, cubierto por `AdapterStatus.available` en tiempo de ejecución).
 */

export type PaymentConnectorStatus = "implementado" | "pendiente";

export interface PaymentConnectorRegistryEntry {
  /** Identificador estable del proveedor -- este es el ÚNICO lugar donde se declara la
   *  lista cerrada de proveedores de pago soportados; ningún otro archivo debe bifurcar
   *  lógica con `if (provider === "stripe")` fuera de aquí. */
  provider: "stripe" | "conekta";
  /** Orden de prioridad de selección en runtime (1 = primero), igual al orden que
   *  `resolvePaymentPort()` documenta. Debe ser estrictamente ascendente y sin huecos --
   *  verificado en tests/unit/mcp-servers/payments/registro-conectores.spec.ts. */
  priority: 1 | 2;
  label: string;
  status: PaymentConnectorStatus;
  notes: string;
}

export const PAYMENT_CONNECTOR_REGISTRY: readonly PaymentConnectorRegistryEntry[] = [
  {
    provider: "stripe",
    priority: 1,
    label: "Stripe",
    status: "implementado",
    notes:
      "Adaptador real (stripe-adapter.ts) + doble de prueba (FakeStripeAdapter). " +
      "resolvePaymentPort() lo prueba primero: si STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET " +
      "están presentes y `status().available`, se usa este.",
  },
  {
    provider: "conekta",
    priority: 2,
    label: "Conekta",
    status: "implementado",
    notes:
      "Adaptador real (conekta-adapter.ts) + doble de prueba (FakeConektaAdapter). " +
      "resolvePaymentPort() lo prueba si Stripe no está disponible.",
  },
] as const;

export function getPaymentConnectorRegistry(): readonly PaymentConnectorRegistryEntry[] {
  return PAYMENT_CONNECTOR_REGISTRY;
}
