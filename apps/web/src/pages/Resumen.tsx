import { useQuery } from "@tanstack/react-query";
import { Percent, Coins, TrendingUp, CalendarCheck } from "lucide-react";
import { StatCard } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { useHotel } from "../hooks/useHotel";
import { obtenerResumen } from "../lib/api";

export function Resumen() {
  const { hotelActivoId } = useHotel();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["resumen", hotelActivoId],
    queryFn: () => obtenerResumen(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const sinDatoPMS = isError || !hotelActivoId ? "Pendiente de credenciales del PMS." : undefined;

  return (
    <div>
      <PageHeader titulo="Resumen" descripcion="Ocupación, tarifa promedio (ADR), RevPAR y reservas del día para el hotel seleccionado." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" aria-busy={isLoading}>
        <StatCard
          icon={Percent}
          label="Ocupación"
          value={data?.ocupacionPct != null ? `${data.ocupacionPct.toFixed(1)}%` : "—"}
          sinDato={data?.ocupacionPct == null ? sinDatoPMS ?? "Sin datos aún." : undefined}
        />
        <StatCard
          icon={Coins}
          label="ADR (tarifa promedio)"
          value={data?.adr != null ? `$${data.adr.toFixed(0)} MXN` : "—"}
          sinDato={data?.adr == null ? sinDatoPMS ?? "Sin datos aún." : undefined}
        />
        <StatCard
          icon={TrendingUp}
          label="RevPAR"
          value={data?.revpar != null ? `$${data.revpar.toFixed(0)} MXN` : "—"}
          sinDato={data?.revpar == null ? sinDatoPMS ?? "Sin datos aún." : undefined}
        />
        <StatCard
          icon={CalendarCheck}
          label="Reservas hoy"
          value={data?.reservasHoy != null ? String(data.reservasHoy) : "—"}
          sinDato={data?.reservasHoy == null ? sinDatoPMS ?? "Sin datos aún." : undefined}
        />
      </div>
      {isError && (
        <button type="button" onClick={() => refetch()} className="mt-4 text-sm text-primary underline underline-offset-2">
          Reintentar
        </button>
      )}
    </div>
  );
}
