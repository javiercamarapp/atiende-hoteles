import type { ReactNode } from "react";

export function PageHeader({ titulo, descripcion, accion }: { titulo: string; descripcion?: string; accion?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">{titulo}</h1>
        {descripcion && <p className="mt-1 text-sm text-muted-foreground max-w-xl">{descripcion}</p>}
      </div>
      {accion}
    </div>
  );
}
