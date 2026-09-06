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

const FORBIDDEN_FIELD_PATTERN =
  /(org.?id|hotel.?id|tenant.?id|guest.?id|actor.?id|staff.?id|property.?id)/i;

function assertNoIdentifierFields(schema: ZodTypeAny, toolName: string): void {
  if (!(schema instanceof z.ZodObject)) {
    // Solo validamos la forma cuando es un objeto; otros tipos (z.void(), etc.) se
    // aceptan tal cual.
    return;
  }
  const shape = schema.shape as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new ToolDefinitionError(
        `la tool "${toolName}" declara el campo "${key}" en su esquema de entrada: los ` +
          `identificadores de tenant/hotel/actor nunca deben venir del modelo (ADR-006, ` +
          `patron Likida "properties: {}")`,
      );
    }
  }
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
