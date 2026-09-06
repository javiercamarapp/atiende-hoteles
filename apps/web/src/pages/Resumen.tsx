import { useQuery } from "@tanstack/react-query";
import { Percent, Coins, TrendingUp, CalendarCheck } from "lucide-react";
import { StatCard, EstadoError } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { useHotel } from "../hooks/useHotel";
import { obtenerResumen } from "../lib/api";

/**
 * REQ-UX-002 / observación del orquestador (docs/PROGRESO.md, entrada H3): con la API
 * propia de Atiende Hoteles caída/inalcanzable el rótulo es "Sin conexión con el API"
 * (EstadoError, con reintentar) — YA NO "Pendiente de credenciales del PMS": estas
 * cifras nunca dependieron del PMS, salen de `reservation`/`availability` propias
 * (H2, apps/api). Con la API respondiendo pero sin filas reales todavía (hotel nuevo,
 * sin disponibilidad cargada), cada cifra individual muestra "Sin datos todavía" —
 * nunca un cero fabricado.
 */
export function Resumen() {
  const { hotelActivoId } = useHotel();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["resumen", hotelActivoId],
    queryFn: () => obtenerResumen(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  if (isError) {
    return (
      <div>
        <PageHeader titulo="Resumen" descripcion="Ocupación, tarifa promedio (ADR), RevPAR y reservas del día para el hotel seleccionado." />
        <EstadoError
          titulo="Sin conexión con el API"
          mensaje="No se pudo conectar con la API de Atiende Hoteles. Verifica tu conexión e inténtalo de nuevo."
          onReintentar={() => refetch()}
        />
      </div>
    );
  }

  const sinDato = !hotelActivoId ? "Sin conexión con el API." : "Sin datos todavía.";

  return (
    <div>
      <PageHeader titulo="Resumen" descripcion="Ocupación, tarifa promedio (ADR), RevPAR y reservas del día para el hotel seleccionado." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" aria-busy={isLoading}>
        <StatCard
          icon={Percent}
          label="Ocupación"
          value={data?.ocupacionPct != null ? `${data.ocupacionPct.toFixed(1)}%` : "—"}
          sinDato={data?.ocupacionPct == null ? sinDato : undefined}
        />
        <StatCard
          icon={Coins}
          label="ADR (tarifa promedio)"
          value={data?.adr != null ? `$${data.adr.toFixed(0)} MXN` : "—"}
          sinDato={data?.adr == null ? sinDato : undefined}
        />
        <StatCard
          icon={TrendingUp}
          label="RevPAR"
          value={data?.revpar != null ? `$${data.revpar.toFixed(0)} MXN` : "—"}
          sinDato={data?.revpar == null ? sinDato : undefined}
        />
        <StatCard
          icon={CalendarCheck}
          label="Reservas hoy"
          value={data?.reservasHoy != null ? String(data.reservasHoy) : "—"}
          sinDato={data?.reservasHoy == null ? sinDato : undefined}
        />
      </div>
    </div>
  );
}
