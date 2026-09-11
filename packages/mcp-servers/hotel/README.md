# @atiende-hoteles/mcp-hotel

REQ-RES-021 (BP-021, H06-004/H06-010/H06-011/H06-012/H06-013, H07-038): servidor MCP
(Model Context Protocol, JSON-RPC 2.0 "tools") de disponibilidad/tarifa/reserva para
que un agente de IA externo consulte y reserve directamente, con datos estructurados
`schema.org Hotel/Offer`.

A diferencia de las demás carpetas de `packages/mcp-servers/*` (puertos hacia
proveedores EXTERNOS como Cloudbeds/Meta/Stripe), este paquete implementa un servidor
MCP que ESTE repo expone hacia afuera -- no hay adaptador "Fake/Simulado" porque no hay
ningún tercero al que llamar: toda la lógica corre contra la base de datos propia.

## Superficie

- `POST /mcp/reservas` (`apps/api/src/routes/mcpHotel.ts`), autenticado con
  `Authorization: Bearer <api key>` -- la key identifica exactamente un hotel (nunca un
  tenant completo), emitida por un owner/gm vía `apps/api/src/routes/mcpAgentes.ts`.
- Métodos JSON-RPC: `initialize`, `tools/list`, `tools/call`.
- Herramientas: `buscar_disponibilidad` (disponibilidad + tarifa neta, JSON-LD
  `Hotel`/`Offer`) y `crear_reserva` (reserva directa, canal `agente_ia_externo`).

## Seguridad (GOB-039/REQ-TEN-004)

Un agente externo no tiene sesión de staff (`hotel_staff`) -- misma categoría de
"escritura de bajo privilegio" que el check-in público o el pedido de experiencias sin
cuenta. Por eso:

- Toda lectura/escritura pasa por una función SQL `SECURITY DEFINER`
  (`packages/db/migrations/0130_mcp_hotel_server.sql`:
  `verify_mcp_agent_credential`/`list_mcp_hotel_availability`/`book_reservation_mcp_agent`),
  nunca por un `INSERT`/`SELECT` directo desde este paquete.
- La herramienta `crear_reserva` **no acepta ningún campo de precio** -- el monto
  siempre se recalcula en el servidor, dentro de la función `SECURITY DEFINER`, a
  partir de `rate_plan` (estructuralmente imposible de manipular, mismo patrón que
  `order_experience_public`, migración 0050).
- Solo se persiste el **hash** (sha256) de la API key, nunca el valor en claro.
- `book_reservation_mcp_agent` reutiliza `book_availability()` (0004/0013) para el
  inventario -- la sobreventa controlada (REQ-RES-007) se sigue respetando exactamente
  igual que en el motor de reservas de staff.
- Idempotencia real: `(mcp_agent_id, mcp_client_request_id)` es único a nivel de
  esquema -- una segunda llamada con el mismo `clientRequestId` devuelve la reserva ya
  creada, nunca duplica.

## Honestidad sobre lo que NO hace

- No cobra ni integra un PSP (H06-011 lo menciona como deseable -- "con autenticación y
  cobro integrado" -- pero REQ-RES-021/ACEPTACION.md no lo exige; la reserva queda en
  estado `cotizada`, igual que cualquier reserva directa sin cargo inmediato, y el cobro
  sigue el mismo camino que folios/pagos del resto del sistema).
- No publica un feed a Google Hotel Center ni presencia en un rail de distribución
  agéntica (LiteAPI/Expedia Rapid/etc., H06-012) -- fuera del alcance literal de
  REQ-RES-021 (H06-012 es un REQ/hallazgo propio, no citado por REQ-RES-021).
- No decide la comisión de 2-4% sobre reservas de agente externo que menciona H06-015 --
  `docs/REQUISITOS.md` (nota §17.1) marca esa pregunta como **no resuelta**
  (conflicto BP-093 vs. H06-015): este cierre solo registra
  `reservation.channel = 'agente_ia_externo'`, el reporte de atribución (REQ-RES-020,
  `hotel_channel_commission`) ya construido queda listo para cuando el fundador decida.
- No gestiona rate limiting específico por agente -- reutiliza el `ipRateLimit` global
  ya montado en `apps/api/src/app.ts` (mismo criterio que
  `cancelacionPublica.ts`/`experienciasPublicas.ts`).

## Pruebas

- `tests/unit/domain-hotel/mcp-hotel-offer.spec.ts` -- mapeo JSON-LD puro.
- `tests/integration/contracts/mcp-hotel/schema.spec.ts` -- servidor MCP real +
  `embedded-postgres` real: `tools/list`, `tools/call buscar_disponibilidad` (valida
  contra `hotelAvailabilityJsonLdSchema`, mide tiempo de respuesta <5s),
  `tools/call crear_reserva` (reserva real, sobreventa respetada, idempotencia).
- `tests/integration/contracts/mcp-hotel/paridad-motor-interno.spec.ts` -- regresión de
  divergencia: el neto que calcula `compute_mcp_room_type_quote()` (SQL) debe coincidir
  con el que calcula `computeQuote()` (TS) para las mismas tarifas.
- `tests/adversarial/mcp-hotel-agente-externo.spec.ts` -- credencial revocada
  rechazada, un agente no puede reservar un tipo de habitación de OTRO hotel, un
  `precio`/`price` inyectado en los argumentos de `crear_reserva` es ignorado.
