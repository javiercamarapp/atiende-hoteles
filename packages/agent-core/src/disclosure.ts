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
