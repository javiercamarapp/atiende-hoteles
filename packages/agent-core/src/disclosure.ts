// H6b · REQ-HUE-006/GOB-034 -- mitad "sesion/API" del disclosure engine que
// packages/agent-core/README.md §8 documentaba como PENDIENTE fuera de este paquete:
// "deteccion de conversacion nueva por canal" + "respuesta fija a '¿eres humano?'".
// Vive aqui (agent-core), NO en apps/api, para que cualquier canal (WhatsApp hoy,
// voz cuando exista) reutilice la MISMA fuente de verdad -- nunca un texto distinto
// hardcodeado por canal (mismo espiritu que el registro de AGENT_DEFINITIONS,
// agents.ts).
//
// El texto de disclosure NO se duplica: se reexporta literalmente
// `AGENT_DEFINITIONS[RECEPCION_VIRTUAL].disclosureMessage` (agents.ts), la MISMA copia
// que `AgentRunner.close()` antepone cuando `ctx.isFirstTurn` es true (runner.ts) --
// asi el nucleo del agente y el canal de WhatsApp nunca pueden divergir en dos strings
// distintos del mismo disclosure legal.
//
// LIMITE EXPLICITO (no una decision de ingenieria): el copy de abajo, igual que
// `disclosureMessage` en agents.ts, es un borrador funcional -- el texto legal FINAL
// aprobado sigue pendiente (ver README.md §8 / docs/auditoria-1/correccion-agent-core.md).
// Cambiar la redaccion es una decision de negocio/legal, no de este paquete.

import { AGENT_DEFINITIONS, RECEPCION_VIRTUAL } from "./agents.ts";

/** Disclosure de IA a enviar en el primer mensaje/turno de una conversacion de
 * WhatsApp (REQ-HUE-006). Reutiliza `AGENT_DEFINITIONS.recepcion_virtual.disclosureMessage`
 * -- ver nota de archivo. */
export const WHATSAPP_DISCLOSURE_MESSAGE: string = (() => {
  const msg = AGENT_DEFINITIONS[RECEPCION_VIRTUAL]?.disclosureMessage;
  if (!msg) {
    throw new Error(
      "AGENT_DEFINITIONS.recepcion_virtual.disclosureMessage no esta configurado -- " +
        "el disclosure de IA (REQ-HUE-006) no tiene texto que enviar.",
    );
  }
  return msg;
})();

// REQ-SEG-001 (H19-001/H19-009): "Aviso de Privacidad... accesible desde el primer
// contacto por WhatsApp/voz/web". auditoria-2/legal [ALTO] encontró que el disclosure de
// arriba (que SÍ es el primer contacto real, ver mensajeria.ts) nunca daba al huésped
// ninguna vía de un clic hacia el aviso -- disclosureMessage se diseñó solo para
// GOB-034 (identificarse como IA) y nunca se le añadió el segundo propósito. Este hook
// es el mecanismo TÉCNICO (genérico sobre cualquier canal, no solo WhatsApp): compone el
// mismo disclosureMessage de siempre + una referencia a la URL real del aviso, que el
// llamador (apps/api, que sí conoce `FRONTEND_URL`) resuelve y pasa aquí -- este paquete
// (agent-core) no conoce URLs de despliegue, solo compone texto.
// LÍMITE EXPLICITO: el TEXTO LEGAL del aviso mismo sigue pendiente de redacción por el
// fundador/equipo legal (ver apps/web/src/pages/Privacidad.tsx `FaltaDato`,
// docs/BLOQUEOS.md) -- lo que este hook garantiza es que, en cuanto ese texto se
// apruebe, ya existe una ruta de un clic hacia él desde el primer mensaje real.
export const AVISO_PRIVACIDAD_PATH = "/privacidad";

/** Compone el disclosure de IA de primer turno + una frase con la URL real del aviso de
 * privacidad (REQ-SEG-001). `avisoPrivacidadUrl` debe ser una URL absoluta ya resuelta
 * por el llamador (típicamente `new URL(AVISO_PRIVACIDAD_PATH, env.frontendUrl)`). */
export function buildDisclosureMessageConAvisoPrivacidad(avisoPrivacidadUrl: string): string {
  if (!avisoPrivacidadUrl || avisoPrivacidadUrl.trim().length === 0) {
    throw new Error(
      "avisoPrivacidadUrl vacía -- REQ-SEG-001 exige que el disclosure de primer contacto enlace al aviso de privacidad real.",
    );
  }
  return `${WHATSAPP_DISCLOSURE_MESSAGE} Puedes leer el aviso de privacidad completo aquí: ${avisoPrivacidadUrl}`;
}

/** Respuesta FIJA (no generativa, nunca sale del LLM) a "¿eres humano?" y variantes
 * cercanas -- REQ-HUE-006 exige texto identico en cada prueba/conversacion. */
export const RESPUESTA_FIJA_ES_HUMANO: string =
  "No, soy un asistente de inteligencia artificial del hotel, no una persona humana. " +
  "Si prefieres hablar con alguien del staff, puedo pedir que te contacten.";

// Variantes comunes en español de "¿eres humano?": "eres humano/persona/robot/bot/IA",
// "hablo con un humano/persona/agente real", "es esto un bot/robot". Insensible a
// acentos/mayúsculas/signos de interrogación (normalizar() los quita antes de probar).
// Deliberadamente acotado a esta pregunta puntual -- no es un clasificador de intención
// general, es la deteccion literal que REQ-HUE-006 pide para UNA pregunta especifica.
const ES_HUMANO_PATTERN =
  /\b(eres|sos|es)\s+(tu\s+)?(un[ao]?\s+)?(humano|persona|robot|bot|ia|inteligencia artificial)\b|\bhablo\s+con\s+(un[ao]?\s+)?(humano|persona|agente real)\b|\b(es|eres)\s+esto\s+(un\s+)?(bot|robot)\b/;

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos: "¿Eres humanó?" -> "eres humano"
    .toLowerCase();
}

/** true si `texto` pregunta, en alguna variante reconocida, si quien responde es
 * humano -- base de la respuesta FIJA de REQ-HUE-006 (nunca generada por el modelo). */
export function esPreguntaSiEsHumano(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return ES_HUMANO_PATTERN.test(normalizar(texto));
}
