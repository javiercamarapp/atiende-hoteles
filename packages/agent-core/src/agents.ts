// H7 · Catálogo de agentes COMO CONFIGURACIÓN (ADR-006, "agentes como datos, no prompts
// sueltos sin dueño"): cada agente vendible declara su rol de modelo (roles.ts), las
// tools que tiene permitido invocar, qué roles de staff pueden dispararlo manualmente
// desde la API, su gate por defecto (siempre "shadow" -- BP-016) y su techo de costo
// mensual por defecto (LLM-026: banda total ≈USD 27-158/mes por hotel de 45
// habitaciones; los valores por agente de abajo sub-dividen esa banda, documentados con
// su fuente, no inventados).
//
// Los 3 agentes de este hito (H7) son los primeros del catálogo de 16 de H17 (a-p):
// recepción virtual (canal, huésped-facing), enrutador de mensajes (clasificación de
// bajo costo) y auditor nocturno de revenue/cierre (batch, Opus 5). Agregar un agente
// nuevo es agregar una entrada aquí, nunca una rama `if (agente === "x")` dispersa por
// la app (mismo espíritu que REQ-AGT-018, "patrón registry").

import type { ModelRole } from "./roles.ts";
import type { AgentGate } from "./roles.ts";
import type { StaffRole } from "./context.ts";
import {
  CONSULTAR_ESTADO_ONBOARDING_TOOL,
  GUARDAR_TIPO_HABITACION_ONBOARDING_TOOL,
  GUARDAR_ZONA_HORARIA_ONBOARDING_TOOL,
  INVITAR_STAFF_ONBOARDING_TOOL,
} from "./tools/onboardingTools.ts";

export interface AgentDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly role: ModelRole;
  /** Roles de staff que pueden disparar este agente manualmente vía
   * `POST /hoteles/:hotelId/agentes/:agente/ejecutar` -- defensa en profundidad además
   * de cualquier RLS (ningún agente de revenue/cierre es accionable por housekeeping). */
  readonly allowedStaffRoles: readonly StaffRole[];
  /** Nombres de tool (tool.ts `ToolDefinition.name`) que este agente tiene permitido
   * invocar -- el ToolRegistry que arma la API SOLO registra estas, nunca el catálogo
   * completo (aislamiento de capacidades por agente, REQ-AGT-001). */
  readonly toolNames: readonly string[];
  /** BP-016: ningún agente nuevo entra en autopilot por omisión. */
  readonly defaultGate: AgentGate;
  /** USD/mes por hotel -- ver comentario de archivo (LLM-026/GOB-036 §2). */
  readonly defaultMonthlyCeilingUsd: number;
  readonly maxSteps: number;
  readonly maxOutputTokensPerCall: number;
  readonly systemPrompt: string;
  /** REQ-HUE-006/GOB-034: disclosure de IA obligatorio desde el primer turno cuando el
   * agente conversa directo con un huésped (no aplica al enrutador/auditor interno). */
  readonly disclosureMessage?: string;
  /** Patrón Likida/atiende.ai #7 ("nunca termina sin preguntar"): reenviado tal cual a
   * `AgentRunnerOptions.completionStatusToolName` (runner.ts) -- nombre de una tool
   * `effect="read"` del catálogo de ESTE agente que decide si puede cerrar "completado"
   * sin más preguntas. `undefined`: sin este requisito (todos los demás agentes). */
  readonly completionStatusToolName?: string;
}

export const RECEPCION_VIRTUAL = "recepcion_virtual";
export const ENRUTADOR_MENSAJES = "enrutador_mensajes";
export const AUDITOR_NOCTURNO = "auditor_nocturno";
export const ONBOARDING_CONVERSACIONAL = "onboarding_conversacional";

export const AGENT_DEFINITIONS: Readonly<Record<string, AgentDefinition>> = {
  [RECEPCION_VIRTUAL]: {
    name: RECEPCION_VIRTUAL,
    label: "Recepción virtual",
    description:
      "Atiende al huésped por WhatsApp/voz/web durante check-in/estancia: crea tareas de housekeeping, " +
      "tickets de mantenimiento y tickets de huésped (room service/F&B y otras solicitudes), envía " +
      "confirmaciones por WhatsApp y registra el valor económico generado.",
    role: "canal",
    allowedStaffRoles: ["owner", "gm", "frontdesk", "reservations"],
    toolNames: [
      "crear_tarea_housekeeping",
      "crear_ticket_mantenimiento",
      "crear_ticket_huesped",
      "enviar_mensaje_whatsapp_plantilla",
      "registrar_evento_roi",
    ],
    defaultGate: "shadow",
    // LLM-026/GOB-036 §2: ≤USD 0.30 por llamada de reserva de ~4 min; a un volumen
    // conservador de check-ins/incidencias por hotel de 45 habitaciones, ~USD 45/mes
    // queda dentro de la banda total (USD 27-158/mes) para el agente de canal principal.
    defaultMonthlyCeilingUsd: 45,
    maxSteps: 6,
    maxOutputTokensPerCall: 1024,
    systemPrompt:
      "Eres el agente de recepción virtual de un hotel independiente. Ayudas al huésped durante su " +
      "check-in/estancia, detectas incidencias y las registras con las herramientas disponibles. Nunca " +
      "decides precio, tarifa, impuesto ni disponibilidad -- eso siempre sale de un motor determinista.",
    disclosureMessage:
      "Soy un asistente de inteligencia artificial del hotel. Un miembro del staff puede intervenir cuando lo necesites.",
  },
  [ENRUTADOR_MENSAJES]: {
    name: ENRUTADOR_MENSAJES,
    label: "Enrutador de mensajes",
    description:
      "Clasifica el idioma/intención de un mensaje entrante (WhatsApp/reseña) y decide a qué flujo/área " +
      "enrutarlo. No ejecuta acciones con efecto -- solo clasifica y explica su decisión en texto.",
    role: "enrutador",
    allowedStaffRoles: ["owner", "gm", "frontdesk", "reservations"],
    // Sin tools: el enrutador solo produce una clasificación en texto (ver LLM-004/009 --
    // ninguna decisión de negocio real sale de este agente).
    toolNames: [],
    defaultGate: "shadow",
    // Haiku 4.5, tarea de bajo costo -- LLM-026: extremo bajo de la banda.
    defaultMonthlyCeilingUsd: 8,
    maxSteps: 2,
    maxOutputTokensPerCall: 256,
    systemPrompt:
      "Clasificas el idioma y la intención de un mensaje entrante de un huésped y devuelves a qué área " +
      "del hotel debería enrutarse (recepción, housekeeping, mantenimiento, reservas, ninguna). No tomas " +
      "ninguna acción, solo clasificas.",
  },
  [AUDITOR_NOCTURNO]: {
    name: AUDITOR_NOCTURNO,
    label: "Auditor nocturno de revenue/cierre",
    description:
      "Corrida batch nocturna (Opus 5, -50% costo Batch API) que revisa el cierre del día y el revenue del " +
      "hotel, y registra el valor económico estimado del período (REQ-AGT-003/REQ-REV-018).",
    role: "batch_nocturno",
    allowedStaffRoles: ["owner", "gm", "accountant"],
    toolNames: ["registrar_evento_roi"],
    defaultGate: "shadow",
    // GOB-036 §2: night audit ≤USD 0.10/corrida, cierre mensual ≤USD 1 -- a corridas
    // diarias durante el mes, ~USD 15/mes queda dentro de la banda total.
    defaultMonthlyCeilingUsd: 15,
    maxSteps: 8,
    maxOutputTokensPerCall: 2048,
    systemPrompt:
      "Eres el auditor nocturno de revenue y cierre de un hotel independiente. Revisas el cierre del " +
      "período y registras el valor económico estimado (nunca inventas una cifra sin método contrafactual " +
      "y nivel de confianza explícitos). No decides precio ni tarifa -- eso sale de un motor determinista.",
  },
  [ONBOARDING_CONVERSACIONAL]: {
    name: ONBOARDING_CONVERSACIONAL,
    label: "Onboarding conversacional",
    description:
      "Guía por chat al dueño/gerente de un hotel nuevo a través de los 3 pasos obligatorios de onboarding " +
      "(tipo de habitación + tarifa base, zona horaria, invitar a su equipo) -- alternativa conversacional al " +
      "wizard estructurado (apps/web /onboarding), que sigue disponible como fallback.",
    role: "canal",
    allowedStaffRoles: ["owner", "gm"],
    toolNames: [
      GUARDAR_TIPO_HABITACION_ONBOARDING_TOOL,
      GUARDAR_ZONA_HORARIA_ONBOARDING_TOOL,
      INVITAR_STAFF_ONBOARDING_TOOL,
      CONSULTAR_ESTADO_ONBOARDING_TOOL,
    ],
    defaultGate: "shadow",
    // Uso esperado: una sola vez por hotel nuevo, no una corrida diaria/por-mensaje --
    // techo bajo, muy por debajo de la banda de un agente de canal continuo (LLM-026).
    defaultMonthlyCeilingUsd: 5,
    maxSteps: 8,
    maxOutputTokensPerCall: 1024,
    systemPrompt:
      "Eres el asistente de onboarding de un hotel independiente que acaba de darse de alta. Tu única meta es " +
      "que el dueño/gerente complete 3 pasos obligatorios, en cualquier orden: (1) registrar al menos un tipo " +
      "de habitación con tarifa base, (2) confirmar la zona horaria del hotel, (3) invitar a al menos un " +
      "miembro de su equipo por correo. Guarda cada dato con su tool en cuanto el usuario te lo confirme -- " +
      "nunca esperes a tener los 3 para guardar el primero. SIEMPRE llama a " +
      `"${CONSULTAR_ESTADO_ONBOARDING_TOOL}" antes de dar el onboarding por terminado: si reporta que falta ` +
      "algo, sigue preguntando por ESO específicamente -- nunca digas que terminaron si todavía falta un paso. " +
      "Nunca decides precio, tarifa, impuesto ni disponibilidad para reservas reales -- ese motor es otro, " +
      "esto es solo la configuración inicial del hotel.",
    completionStatusToolName: CONSULTAR_ESTADO_ONBOARDING_TOOL,
  },
};

export function getAgentDefinition(name: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS[name];
}

export function listAgentDefinitions(): AgentDefinition[] {
  return Object.values(AGENT_DEFINITIONS);
}
