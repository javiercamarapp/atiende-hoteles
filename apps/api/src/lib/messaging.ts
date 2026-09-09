// H6b · Selección condicional del adaptador de WhatsApp, MISMO patrón que
// `resolveEmailPort` (apps/api/src/emailOutbox/runEmailOutboxWorker.ts): con las 3
// credenciales de Meta presentes (`WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
// `WHATSAPP_APP_SECRET`) se usa `MetaWhatsappAdapter` real; sin ellas (el caso de
// desarrollo/CI de hoy) se mantiene exactamente el comportamiento anterior
// (`FakeWhatsappAdapter`, `simulated: true`, ADR-007 "PENDIENTE DE CREDENCIALES").
//
// Hallazgo de auditoría corregido: antes de este fix, `sharedWhatsappAdapter` estaba
// hardcodeado a `FakeWhatsappAdapter` sin ninguna rama condicional -- a diferencia del
// patrón ya usado para correo, ningún envío de WhatsApp podía volverse real ni con las
// credenciales de Meta configuradas en producción.
//
// SIGUE siendo una ÚNICA instancia compartida por todo el proceso (mismo motivo que el
// comentario original: el contador de `externalMessageId`/la ventana de 24h del tier de
// mensajería del Fake son estado del ADAPTADOR, no de la petición HTTP; para el
// adaptador real, `sendIdempotency`/`replayGuard` internos de `MetaWhatsappAdapter`
// también son estado del proceso, no de la petición).
import { FakeWhatsappAdapter, MetaWhatsappAdapter, type MessagingPort } from "@atiende-hoteles/mcp-whatsapp";

/** Instancia fresca del adaptador real/simulado según credenciales -- exportada (además
 *  del singleton de abajo) para que las pruebas puedan ejercitar la selección misma sin
 *  depender de en qué orden se importó este módulo (ver
 *  tests/unit/api/messaging-adapter-selection.spec.ts). */
export function resolveWhatsappAdapter(): MessagingPort {
  const meta = new MetaWhatsappAdapter();
  if (meta.status().available) return meta;
  return new FakeWhatsappAdapter();
}

export const sharedWhatsappAdapter: MessagingPort = resolveWhatsappAdapter();

/** `true` mientras `sharedWhatsappAdapter` sea el Fake (sin credenciales de Meta) --
 *  reemplaza el `simulated: true` que routes/mensajeria.ts tenía hardcodeado para
 *  `MessagingToolDeps.simulated` (persistido en `message.simulated`, ver
 *  packages/agent-core/src/tools/messagingTools.ts): el panel nunca debe aparentar una
 *  entrega real que no ocurrió, ni al revés, ocultar que sí es real cuando ya lo es. */
export const whatsappAdapterSimulated: boolean = sharedWhatsappAdapter.status().simulated;

/**
 * Verificador de webhook entrante para UN hotel. Construye un `MetaWhatsappAdapter`
 * FRESCO (no el singleton `sharedWhatsappAdapter`) y lo usa si tiene credenciales --
 * chequeo dinámico a propósito, igual que `resolveWhatsappAdapter()`, para que un cambio
 * de credenciales en el entorno se refleje en la SIGUIENTE petición sin reiniciar el
 * proceso (ambos webhooks ya construían un adaptador nuevo por petición antes de este
 * fix, así que esto no cambia el ciclo de vida, solo cuál adaptador se construye). Con
 * credenciales de Meta presentes, Meta firma TODO webhook de la app con el mismo
 * `WHATSAPP_APP_SECRET` único (a nivel de app, no por número/hotel), así que la
 * verificación real ignora `hotelWebhookSecret` -- ese campo por hotel
 * (`hotel_messaging_config.webhook_secret`, generado con `randomUUID()`) solo tiene
 * sentido para el adaptador Fake de desarrollo/pruebas (donde cada prueba firma sus
 * propios fixtures contra ESE secreto, sin depender de ninguna variable de entorno).
 *
 * [LIMITACIÓN CONOCIDA, documentada en README.md]: Meta Cloud API registra un ÚNICO
 * webhook por app (no uno por número de WhatsApp/hotel) -- este repo expone una URL por
 * hotel (`/hoteles/:hotelId/mensajeria/webhook`), lo cual funciona para un Tech Provider
 * con Embedded Signup solo si cada hotel usa una app de Meta separada, o si se agrega
 * más adelante un enrutamiento por `phone_number_id` del payload hacia un único endpoint
 * compartido. No se resuelve aquí (fuera del alcance de este fix) para no introducir un
 * cambio de arquitectura no pedido; se deja registrado explícitamente para la primera
 * integración real.
 */
export function resolveWhatsappWebhookVerifier(
  hotelWebhookSecret: string,
): Pick<MessagingPort, "verifyAndNormalizeWebhook"> {
  const meta = new MetaWhatsappAdapter();
  if (meta.status().available) return meta;
  return new FakeWhatsappAdapter(undefined, undefined, hotelWebhookSecret);
}
