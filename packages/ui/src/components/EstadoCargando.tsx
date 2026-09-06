import { Skeleton } from "./ui/skeleton";

/**
 * Portado de EstadoCargando (kit.tsx) — skeleton shimmer con
 * role="status"/aria-busy, mismo mecanismo que LoadingScreen de
 * atiende-restaurantes (05§2.7). REQ-UX-002/003.
 */
export function EstadoCargando({ lineas = 3, etiqueta = "Cargando…" }: { lineas?: number; etiqueta?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={etiqueta} className="space-y-3">
      <span className="sr-only">{etiqueta}</span>
      <Skeleton className="h-24 w-full rounded-xl" />
      {Array.from({ length: lineas }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full rounded" style={{ maxWidth: `${92 - i * 12}%` }} />
      ))}
    </div>
  );
}
