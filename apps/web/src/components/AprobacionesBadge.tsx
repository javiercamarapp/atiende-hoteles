// H6b · Badge del encabezado con el conteo REAL de aprobaciones pendientes del hotel
// activo (nunca una cifra inventada: sin dato, no se muestra número). Enlaza a
// /aprobaciones. Se re-consulta cada 20s -- suficiente para housekeeping/mantenimiento
// sin depender de websockets, que están fuera de alcance de este hito.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BellRing } from "lucide-react";
import { useHotel } from "../hooks/useHotel";
import { listarAprobaciones } from "../lib/api";

export function AprobacionesBadge() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["aprobaciones-pendientes-badge", hotelActivoId],
    queryFn: () => listarAprobaciones(hotelActivoId as string, "pendiente"),
    enabled: Boolean(hotelActivoId),
    retry: false,
    refetchInterval: 20_000,
  });

  const pendientes = query.data?.length ?? 0;

  return (
    <Link
      to="/aprobaciones"
      aria-label={pendientes > 0 ? `${pendientes} aprobaciones pendientes` : "Aprobaciones"}
      className="relative inline-flex items-center justify-center min-h-11 min-w-11 rounded-full border border-border bg-card hover:bg-muted transition-colors"
    >
      <BellRing className="size-5" aria-hidden="true" />
      {pendientes > 0 && (
        <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground">
          {pendientes > 99 ? "99+" : pendientes}
        </span>
      )}
    </Link>
  );
}
