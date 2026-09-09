// H18 · conector-pms-enterprise: `resolveOutboundTaskSyncPort()` elige el adaptador REAL
// del conector outbound genérico -- mismo patrón que `resolvePaymentPort()`
// (resolvePaymentPort.ts): `server.ts` (arranque real) lo llama y pasa el resultado a
// `AppDeps.outboundTaskSync`; `createApp()` sigue usando `FakeOutboundTaskSyncAdapter`
// como default SOLO cuando nadie pasa `deps.outboundTaskSync` (pruebas).
//
// A diferencia de `resolvePaymentPort()` (Stripe > Conekta > Fake, según qué CREDENCIAL
// de proceso exista), aquí no hay una credencial global que decidir: la credencial es
// POR HOTEL (`hotel_pms_outbound_config`, ver `OutboundTaskSyncGateway`) -- el mecanismo
// de envío en sí (`WebhookOutboundAdapter`) no depende de ninguna variable de entorno.
// Lo que SÍ vale la pena resolver aquí es un interruptor de apagado operativo global
// (`OUTBOUND_PMS_SYNC_DISABLED`): si el conector empieza a comportarse mal en producción
// (p.ej. satura de reintentos a un hotel, o un bug en la firma), operar puede apagarlo
// para TODOS los hoteles con una sola variable de entorno, sin tener que desactivar la
// fila de cada hotel en `hotel_pms_outbound_config` una por una.
import { FakeOutboundTaskSyncAdapter, WebhookOutboundAdapter, type OutboundTaskSyncPort } from "@atiende-hoteles/mcp-outbound";

export function resolveOutboundTaskSyncPort(env: Record<string, string | undefined> = process.env): OutboundTaskSyncPort {
  if (env.OUTBOUND_PMS_SYNC_DISABLED === "true") return new FakeOutboundTaskSyncAdapter();
  return new WebhookOutboundAdapter();
}
