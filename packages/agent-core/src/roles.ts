// Runtime por rol (DECISIONLLM, docs/referencia/01-blueprint-y-decision-llm.md §3 y
// LLM-008): un solo mapa ModelRole -> slug, igual que `models.ts` de Likida (§2.7) --
// override por variable de entorno, cada default con su justificacion en comentario.
// Los gates shadow -> propone -> autopilot (BP-016/BP-053/BP-054/GOB-036) son datos por
// (hotel, agente), nunca logica dispersa.

export type ModelRole = "canal" | "enrutador" | "batch_nocturno";

export const DEFAULT_MODEL_BY_ROLE: Readonly<Record<ModelRole, string>> = {
  // Sonnet 5: conversacion/reservas en canal (WhatsApp/voz/web), effort low en voz y
  // medium en texto (GOB-033). Fuente: LLM-008/LLM-013/LLM-014.
  canal: "claude-sonnet-5",
  // Haiku 4.5: enrutamiento de idioma/intencion y tareas de bajo costo (housekeeping,
  // clasificacion). Fuente: LLM-008.
  enrutador: "claude-haiku-4-5",
  // Opus 5 en modo Batch (-50% costo) para GM Copilot/Revenue/cierre CFO nocturno.
  // Fuente: LLM-008, decision de arquitectura §3.1.
  batch_nocturno: "claude-opus-5",
};

const ROLE_ENV_VAR: Readonly<Record<ModelRole, string>> = {
  canal: "AGENT_MODEL_CANAL",
  enrutador: "AGENT_MODEL_ENRUTADOR",
  batch_nocturno: "AGENT_MODEL_BATCH_NOCTURNO",
};

/** Resuelve el slug de modelo para un rol: override por env si esta presente y no vacio,
 * si no el default documentado. Cambiar de modelo cuesta una variable, no un despliegue. */
export function resolveModelForRole(
  role: ModelRole,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[ROLE_ENV_VAR[role]];
  return override && override.trim().length > 0 ? override : DEFAULT_MODEL_BY_ROLE[role];
}

export interface RoleParams {
  readonly temperature: number;
  readonly effort: "low" | "medium" | "high";
}

/** `temperature: 0` en los tres roles porque cualquiera de ellos puede tocar dinero via
 * tool (cotizar, cerrar folio, revenue nocturno) — GOB-032/LLM-020. */
export const ROLE_PARAMS: Readonly<Record<ModelRole, RoleParams>> = {
  canal: { temperature: 0, effort: "medium" },
  enrutador: { temperature: 0, effort: "low" },
  batch_nocturno: { temperature: 0, effort: "high" },
};

/** Canal conversacional del turno en curso. Solo distingue voz de todo lo demas porque
 * REQ-AGT-005/REQ-AGT-016 (TTFT <600ms p50) es especificamente un requisito de VOZ. */
export type Channel = "voz" | "texto";

/**
 * aud-1 agentico.md MEDIO: `ROLE_PARAMS.canal.effort` era un unico valor fijo
 * ("medium") para TODO el canal conversacional, sin distinguir voz de texto/WhatsApp --
 * contradecia REQ-AGT-005 ("effort bajo en canales de voz y WhatsApp") y el propio
 * comentario de ADR-006 citado arriba ("effort low en voz, medium en texto"). Esta
 * funcion agrega la dimension de canal que falta SIN romper el default existente:
 * sin `channel` (o para enrutador/batch_nocturno, que no varian por canal) devuelve
 * `ROLE_PARAMS[role]` tal cual; para `canal` + `channel: "voz"` baja el effort a "low".
 */
export function roleParamsForChannel(role: ModelRole, channel?: Channel): RoleParams {
  const base = ROLE_PARAMS[role];
  if (role === "canal" && channel === "voz") {
    return { ...base, effort: "low" };
  }
  return base;
}

/** Modo copiloto -> autopilot por (hotel, agente): BP-016/BP-053/BP-054/GOB-036. */
export type AgentGate = "shadow" | "propone" | "autopilot";

export interface GateKey {
  readonly hotelId: string;
  readonly agent: string;
}

export interface GateResolver {
  resolve(key: GateKey): AgentGate;
}

function gateCacheKey(key: GateKey): string {
  return `${key.hotelId}::${key.agent}`;
}

/**
 * Resolver estatico (hotel, agente) -> gate. Sin entrada explicita, el default es
 * "shadow": ningun agente nuevo entra en autopilot por omision (BP-016: revenue en
 * shadow 90 dias antes de proponer/ejecutar; mismo principio para cualquier agente).
 */
export class StaticGateResolver implements GateResolver {
  private readonly map = new Map<string, AgentGate>();
  private readonly defaultGate: AgentGate;

  constructor(entries: ReadonlyArray<readonly [GateKey, AgentGate]> = [], defaultGate: AgentGate = "shadow") {
    this.defaultGate = defaultGate;
    for (const [key, gate] of entries) {
      this.map.set(gateCacheKey(key), gate);
    }
  }

  set(key: GateKey, gate: AgentGate): void {
    this.map.set(gateCacheKey(key), gate);
  }

  resolve(key: GateKey): AgentGate {
    return this.map.get(gateCacheKey(key)) ?? this.defaultGate;
  }
}
