// H6b · Instancia COMPARTIDA de `FakeWhatsappAdapter` para todo el proceso de la API
// (ADR-007, "PENDIENTE DE CREDENCIALES" -- nunca un adaptador real de Meta en este hito).
// Debe ser una ÚNICA instancia: su contador de `externalMessageId` ("WA-MSG-N") y su
// ventana de 24h del tier de mensajería son estado del ADAPTADOR, no de la petición HTTP
// -- crear una instancia nueva por request (como hacía cada ruta antes) producía
// `externalMessageId` repetidos entre rutas distintas (mensajeria.ts al enviar,
// aprobaciones.ts al ejecutar tras la doble confirmación), chocando con el índice único
// `message_hotel_external_message_idx` (0044).
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";

export const sharedWhatsappAdapter = new FakeWhatsappAdapter();
