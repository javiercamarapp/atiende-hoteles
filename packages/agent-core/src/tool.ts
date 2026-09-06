// Patron Likida (docs/referencia/06-backoffice-agentes-likida.md §2.5): las tools NUNCA
// reciben datos identificadores del modelo. `tenant_id`/`hotel_id`/`guest_id`/etc. vienen
// siempre del ToolContext inyectado por el servidor. `defineTool()` valida esto en tiempo
// de definicion (no solo por convencion) y ademas hace cumplir GOB-026: toda tool con
// efecto external/money exige `needsApproval: true`, y las tools de precio/emision no
// pueden declarar `alwaysApprove`.

import { z, type ZodType, type ZodTypeAny } from "zod";
import { ToolDefinitionError } from "./errors.ts";
import type { ToolContext } from "./context.ts";

export type ToolEffect = "read" | "write" | "external" | "money";

export interface ToolResult {
  readonly ok: boolean;
  /** Explicacion humana breve (BP-003: <=40 palabras), nunca PII cruda sin redactar. */
  readonly summary: string;
  readonly data?: unknown;
}

export interface ToolDefinitionSpec<TInput> {
  readonly name: string;
  readonly description: string;
  /** Zod puede ser `z.object({})`: el patron Likida es declarar `properties: {}` a
   * proposito cuando la tool no necesita nada del modelo (todo viene del ToolContext). */
  readonly inputSchema: ZodType<TInput>;
  readonly effect: ToolEffect;
  /** Obligatorio (=true) cuando effect es "external" o "money" (GOB-026). */
  readonly needsApproval: boolean;
  /** Marca tools de precio/tarifa/emision de cargo o reserva (GOB-026). */
  readonly isPriceOrEmission?: boolean;
  /** Aprobacion automatica de una tool con needsApproval=true. Prohibido junto con
   * isPriceOrEmission=true. */
  readonly alwaysApprove?: boolean;
  readonly run: (ctx: ToolContext, input: TInput) => Promise<ToolResult> | ToolResult;
}

export type ToolDefinition<TInput = unknown> = ToolDefinitionSpec<TInput>;

// aud-1 tool-calling.md ALTO #1: lista CONFIGURABLE de sinonimos prohibidos -- un futuro
// `packages/domain-hotel` puede registrar sinonimos adicionales propios del dominio con
// `registerForbiddenIdentifierPattern()` sin tener que editar este archivo. `location`
// se agrega aqui porque, segun `packages/db/migrations/0002_org_location_hotel.sql` y
// `packages/db/README.md`, `location` es el nombre real de la entidad que representa un
// hotel (`location.kind='hotel'`) -- un identificador de hotel por otro nombre.
export const DEFAULT_FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  /org.?id/i,
  /hotel.?id/i,
  /tenant.?id/i,
  /guest.?id/i,
  /actor.?id/i,
  /staff.?id/i,
  /property.?id/i,
  /location.?id/i,
];

const forbiddenFieldPatterns: RegExp[] = [...DEFAULT_FORBIDDEN_FIELD_PATTERNS];

/** Registra un sinonimo adicional de identificador prohibido (p.ej. desde
 * packages/domain-hotel cuando aparezca un nombre de campo propio del dominio que
 * tambien identifique tenant/hotel/actor). Afecta a TODAS las tools definidas despues
 * de la llamada, en cualquier paquete que comparta este modulo. */
export function registerForbiddenIdentifierPattern(pattern: RegExp): void {
  forbiddenFieldPatterns.push(pattern);
}

function isForbiddenFieldName(key: string): boolean {
  return forbiddenFieldPatterns.some((pattern) => pattern.test(key));
}

/** Desenvuelve wrappers que no cambian la forma verificable (optional/nullable/default)
 * para llegar al tipo real declarado. */
function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    current = (current._def as unknown as { innerType: ZodTypeAny }).innerType;
  }
  return current;
}

/**
 * Recorre el ESQUEMA COMPLETO (no solo el primer nivel) de una tool buscando
 * identificadores de tenant/hotel/actor: objetos anidados, arreglos de objetos,
 * uniones. Rechaza de forma estructural cualquier esquema cuyas claves no se puedan
 * enumerar y verificar por completo -- `.passthrough()`/`.catchall()` (deja pasar
 * cualquier campo no declarado, incluido un identificador), `z.record(...)` (claves
 * arbitrarias) y `z.any()`/`z.unknown()` (cualquier valor, incluido un objeto con un
 * identificador adentro) -- en vez de aceptarlos por no ser un `ZodObject` de primer
 * nivel (aud-1 tool-calling.md ALTO #1).
 */
function assertNoIdentifierFields(schema: ZodTypeAny, toolName: string, path = ""): void {
  const label = path || "(raiz)";
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodAny || unwrapped instanceof z.ZodUnknown) {
    throw new ToolDefinitionError(
      `la tool "${toolName}" usa z.any()/z.unknown() en "${label}": ese campo podria traer ` +
        `un identificador de tenant/hotel/actor sin que nada lo detecte (ADR-006)`,
    );
  }

  if (unwrapped instanceof z.ZodRecord) {
    throw new ToolDefinitionError(
      `la tool "${toolName}" usa z.record(...) en "${label}": las claves arbitrarias no se ` +
        `pueden verificar contra identificadores prohibidos (ADR-006)`,
    );
  }

  if (unwrapped instanceof z.ZodArray) {
    assertNoIdentifierFields((unwrapped._def as unknown as { element: ZodTypeAny }).element, toolName, `${label}[]`);
    return;
  }

  if (unwrapped instanceof z.ZodUnion) {
    for (const option of (unwrapped._def as unknown as { options: readonly ZodTypeAny[] }).options) {
      assertNoIdentifierFields(option, toolName, label);
    }
    return;
  }

  if (unwrapped instanceof z.ZodObject) {
    const def = unwrapped._def as { catchall?: ZodTypeAny };
    if (def.catchall && !(def.catchall instanceof z.ZodNever)) {
      throw new ToolDefinitionError(
        `la tool "${toolName}" declara un esquema .passthrough()/.catchall() en "${label}": ` +
          `permite colar cualquier campo no declarado (incluido un identificador de tenant/hotel/actor) ` +
          `sin que el esquema lo verifique (ADR-006)`,
      );
    }
    const shape = unwrapped.shape as Record<string, ZodTypeAny>;
    for (const key of Object.keys(shape)) {
      if (isForbiddenFieldName(key)) {
        throw new ToolDefinitionError(
          `la tool "${toolName}" declara el campo "${path ? `${path}.${key}` : key}" en su esquema de ` +
            `entrada: los identificadores de tenant/hotel/actor nunca deben venir del modelo (ADR-006, ` +
            `patron Likida "properties: {}")`,
        );
      }
      assertNoIdentifierFields(shape[key]!, toolName, path ? `${path}.${key}` : key);
    }
    return;
  }

  // Tipos primitivos (string, number, boolean, enum, etc.): nada mas que verificar.
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function defineTool<TInput>(spec: ToolDefinitionSpec<TInput>): ToolDefinition<TInput> {
  if (!spec.name || !NAME_PATTERN.test(spec.name)) {
    throw new ToolDefinitionError(
      `nombre de tool invalido: "${spec.name}" (usar snake_case, iniciando con una letra)`,
    );
  }
  if ((spec.effect === "external" || spec.effect === "money") && spec.needsApproval !== true) {
    throw new ToolDefinitionError(
      `la tool "${spec.name}" tiene effect="${spec.effect}" y debe declarar needsApproval: true (GOB-026)`,
    );
  }
  if (spec.isPriceOrEmission && spec.alwaysApprove === true) {
    throw new ToolDefinitionError(
      `la tool "${spec.name}" es de precio/emision: alwaysApprove esta prohibido (GOB-026)`,
    );
  }
  assertNoIdentifierFields(spec.inputSchema, spec.name);
  return { ...spec };
}

/** Registro unico de tools (mismo espiritu que el `AGENT_REGISTRY` de Likida §2.4). */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registro heterogeneo: cada tool trae su propio TInput.
  register(tool: ToolDefinition<any>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolDefinitionError(`tool duplicada en el registro: "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}
