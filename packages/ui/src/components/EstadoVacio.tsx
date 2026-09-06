import type { ComponentType } from "react";
import { Inbox } from "lucide-react";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

/**
 * Patrón "nunca inventar una cifra" (docs/referencia/06-backoffice-agentes-likida.md
 * §3.5, EstadoVacio de kit.tsx) portado literal para Atiende Hoteles: tarjeta
 * con ícono + mensaje cuando no hay dato real, en vez de simular un cero o
 * dejar la pantalla en blanco. REQ-UX-002.
 */
export function EstadoVacio({
  icon: Icon = Inbox,
  titulo = "Sin datos aún",
  mensaje,
  accion,
}: {
  icon?: IconType;
  titulo?: string;
  mensaje: string;
  accion?: React.ReactNode;
}) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="w-5 h-5" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{titulo}</p>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">{mensaje}</p>
      </div>
      {accion}
    </div>
  );
}
