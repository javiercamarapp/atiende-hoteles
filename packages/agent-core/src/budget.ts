// Presupuesto por corrida (patron `presupuesto.ts`/`acotada()` de Likida, ver
// docs/referencia/06-backoffice-agentes-likida.md §2.3): un solo reloj compartido por
// tokens, tiempo y costo estimado, consultado por cada etapa del AgentRunner en vez de
// que cada llamada tenga su propio timeout que ignora a las demas.

export interface BudgetLimits {
  readonly maxTokens?: number;
  readonly maxMs?: number;
  readonly maxUsd?: number;
}

export interface BudgetSnapshot {
  readonly tokensUsed: number;
  readonly elapsedMs: number;
  readonly usdSpent: number;
}

export interface RunBudget {
  readonly limits: BudgetLimits;
  snapshot(): BudgetSnapshot;
  remainingMs(): number | undefined;
  remainingTokens(): number | undefined;
  remainingUsd(): number | undefined;
  /** true si CUALQUIER dimension configurada ya llego a su tope. */
  agotado(): boolean;
  registrarTokens(inputTokens: number, outputTokens: number): void;
  registrarCostoUsd(usd: number): void;
}

export function createRunBudget(limits: BudgetLimits, now: () => number = Date.now): RunBudget {
  const start = now();
  let tokensUsed = 0;
  let usdSpent = 0;

  return {
    limits,
    snapshot(): BudgetSnapshot {
      return { tokensUsed, elapsedMs: now() - start, usdSpent };
    },
    remainingMs(): number | undefined {
      if (limits.maxMs === undefined) return undefined;
      return Math.max(0, limits.maxMs - (now() - start));
    },
    remainingTokens(): number | undefined {
      if (limits.maxTokens === undefined) return undefined;
      return Math.max(0, limits.maxTokens - tokensUsed);
    },
    remainingUsd(): number | undefined {
      if (limits.maxUsd === undefined) return undefined;
      return Math.max(0, limits.maxUsd - usdSpent);
    },
    agotado(): boolean {
      if (limits.maxMs !== undefined && now() - start >= limits.maxMs) return true;
      if (limits.maxTokens !== undefined && tokensUsed >= limits.maxTokens) return true;
      if (limits.maxUsd !== undefined && usdSpent >= limits.maxUsd) return true;
      return false;
    },
    registrarTokens(inputTokens: number, outputTokens: number): void {
      tokensUsed += inputTokens + outputTokens;
    },
    registrarCostoUsd(usd: number): void {
      usdSpent += usd;
    },
  };
}
