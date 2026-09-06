import type { ReactNode } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { ApiUnavailableError } from "../lib/api";

/**
 * Envoltura común para el patrón "nunca inventar una cifra" (REQ-UX-002):
 * cargando → EstadoCargando; error → EstadoError (nombra la integración,
 * declara "pendiente de credenciales" si aplica); sin filas → EstadoVacio;
 * con datos → renderiza `children(data)`. Todas las pantallas de módulo
 * usan este mismo componente para no duplicar la disciplina en cada una.
 */
export function DataState<T>({
  isLoading,
  error,
  data,
  esVacio,
  mensajeVacio,
  onReintentar,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  esVacio?: (data: T) => boolean;
  mensajeVacio: string;
  onReintentar?: () => void;
  children: (data: T) => ReactNode;
}) {
  if (isLoading) return <EstadoCargando />;

  if (error) {
    const err = error instanceof ApiUnavailableError ? error : null;
    return (
      <EstadoError
        integracion={err?.integracion ?? "API de Atiende Hoteles"}
        pendienteCredenciales={err?.pendienteCredenciales ?? false}
        mensaje={err ? undefined : (error as Error)?.message}
        onReintentar={onReintentar}
      />
    );
  }

  if (data === undefined || (esVacio ? esVacio(data) : Array.isArray(data) && (data as unknown[]).length === 0)) {
    return <EstadoVacio mensaje={mensajeVacio} />;
  }

  return <>{children(data)}</>;
}
