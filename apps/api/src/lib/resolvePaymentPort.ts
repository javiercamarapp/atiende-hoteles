// H15-007/REQ-INT-002 · `resolvePaymentPort()` elige el adaptador REAL de pagos según las
// credenciales presentes en el entorno del proceso -- mismo patrón que
// `resolveEmailPort()` (apps/api/src/emailOutbox/runEmailOutboxWorker.ts, Resend > SMTP >
// Fake). Antes de esto, `createApp()` (app.ts) SIEMPRE instanciaba `FakeStripeAdapter`
// como único default, sin importar qué credenciales tuviera configuradas el proceso real
// -- `server.ts` nunca llamaba a nada que resolviera un adaptador real, así que en
// producción el cobro a huéspedes corría contra el Fake sin importar qué se configurara
// en `STRIPE_SECRET_KEY`/`CONEKTA_PRIVATE_KEY` (hallazgo de auditoría de producción,
// 2026-09-09). `resolvePaymentPort()` cierra ese hueco: `server.ts` (arranque real) lo
// llama y pasa el resultado a `AppDeps.payments`; `createApp()` sigue usando
// `FakeStripeAdapter` como default SOLO cuando nadie pasa `deps.payments` (pruebas, que
// nunca configuran credenciales reales).
//
// Orden de selección -- por cuál credencial está presente, igual que `resolveEmailPort()`
// (Resend > SMTP > Fake): no se agrega una variable `PAYMENT_PROVIDER` explícita porque
// nadie la pidió (este cambio corrige el wiring que faltaba, no diseña configuración
// nueva) -- si en el futuro un hotel necesita fijar el proveedor sin depender de qué
// variable exista, esa es una decisión de producto separada.
//   1. `STRIPE_SECRET_KEY` (+`STRIPE_WEBHOOK_SECRET`) presentes -> `StripeAdapter` real.
//   2. si no, `CONEKTA_PRIVATE_KEY` (+`CONEKTA_WEBHOOK_SECRET`) presentes -> `ConektaAdapter` real.
//   3. si no, `FakeStripeAdapter` -- mismo default histórico, `simulated: true` explícito.
//
// Se resuelve UNA sola vez por proceso (mismo motivo ya documentado en `app.ts` para el
// default `FakeStripeAdapter`: el `InMemoryReplayGuard` de webhooks de cada adaptador
// vive en memoria del proceso, no por request).
import { StripeAdapter, ConektaAdapter, FakeStripeAdapter, type PaymentProviderPort } from "@atiende-hoteles/mcp-payments";

export function resolvePaymentPort(): PaymentProviderPort {
  const stripe = new StripeAdapter();
  if (stripe.status().available) return stripe;
  const conekta = new ConektaAdapter();
  if (conekta.status().available) return conekta;
  return new FakeStripeAdapter();
}
