import { TrendingUp, TrendingDown, ChevronRight } from "lucide-react";

type IconType = React.ComponentType<{ className?: string; strokeWidth?: number | string }>;

/**
 * Anatomía portada 1:1 de atiende-restaurantes (StatCard/TrendStatCard,
 * docs/referencia/05-frontend-restaurantes.md §3.3) con la disciplina de
 * "nunca inventar una cifra" de Likida (06-backoffice-agentes-likida.md
 * §3.5) añadida explícitamente vía la prop `sinDato`: cuando no hay dato
 * real, la tarjeta muestra un guion — nunca un 0 — y explica por qué.
 */
export function StatCard({
  icon: Icon,
  label,
  value,
  nota,
  verMas,
  sinDato,
}: {
  icon: IconType;
  label: string;
  value: string;
  nota?: string;
  verMas?: boolean;
  /** Razón por la que no hay cifra real todavía (ej. "Pendiente de credenciales del PMS"). Si se pasa, la tarjeta ignora `value`/`nota` y muestra "—" con esta explicación. */
  sinDato?: string;
}) {
  const mostrarSinDato = Boolean(sinDato);
  return (
    <div className="bg-card border border-border rounded-xl p-2">
      <div className="rounded-lg px-3 py-2.5 bg-muted">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground flex items-center justify-center shrink-0">
              <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
            </div>
            <span className="text-[13px] text-muted-foreground truncate">{label}</span>
          </div>
          {verMas && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
              Ver más <ChevronRight className="w-2.5 h-2.5" />
            </span>
          )}
        </div>
        <p
          className="font-display text-xl font-semibold tabular-nums text-foreground"
          aria-label={mostrarSinDato ? `${label}: sin dato` : undefined}
        >
          {mostrarSinDato ? "—" : value}
        </p>
      </div>
      {(mostrarSinDato || nota) && (
        <div className="mx-1.5 mt-1.5 pt-1.5 border-t border-dashed border-border">
          <p
            className={
              mostrarSinDato
                ? "text-[11px] text-muted-foreground"
                : nota!.trim().startsWith("+")
                  ? "text-[11px] text-green-600 dark:text-green-500"
                  : nota!.trim().startsWith("-")
                    ? "text-[11px] text-destructive"
                    : "text-[11px] text-muted-foreground"
            }
          >
            {mostrarSinDato ? sinDato : nota}
          </p>
        </div>
      )}
    </div>
  );
}

export function TrendStatCard({
  icon: Icon,
  label,
  value,
  deltaPct,
  deltaLabel = "vs periodo anterior",
  onVerMas,
  sinDato,
}: {
  icon: IconType;
  label: string;
  value: string;
  deltaPct?: number;
  deltaLabel?: string;
  onVerMas?: () => void;
  sinDato?: string;
}) {
  const mostrarSinDato = Boolean(sinDato);
  const subiendo = (deltaPct ?? 0) >= 0;
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4" strokeWidth={1.75} />
          </div>
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
        {onVerMas && (
          <button onClick={onVerMas} className="text-sm text-primary hover:underline underline-offset-2 shrink-0">
            Ver más
          </button>
        )}
      </div>
      <p className="font-display text-2xl font-semibold tabular-nums text-foreground mb-3" aria-label={mostrarSinDato ? `${label}: sin dato` : undefined}>
        {mostrarSinDato ? "—" : value}
      </p>
      {mostrarSinDato ? (
        <p className="text-xs text-muted-foreground">{sinDato}</p>
      ) : (
        deltaPct !== undefined && (
          <div
            className={
              "flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm " +
              (subiendo ? "bg-[hsl(142_71%_45%/0.12)] text-[hsl(142_71%_29%)]" : "bg-[hsl(0_72%_51%/0.12)] text-[hsl(0_72%_41%)]")
            }
          >
            {subiendo ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            <span className="font-medium tabular-nums">
              {subiendo ? "+" : ""}
              {deltaPct.toFixed(1)}%
            </span>
            <span className="text-xs opacity-80">{deltaLabel}</span>
          </div>
        )
      )}
    </div>
  );
}
