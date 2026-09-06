import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Percent, Coins, TrendingUp, CalendarCheck, Sparkles } from "lucide-react";
import { StatCard, EstadoError, Card, CardHeader, CardTitle, CardContent, Badge, formatMoney } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { useHotel } from "../hooks/useHotel";
import { obtenerResumen, obtenerRoi } from "../lib/api";

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
  const roi = useQuery({
    queryKey: ["roi-resumen", hotelActivoId],
    queryFn: () => obtenerRoi(hotelActivoId as string),
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
          value={data?.adr != null ? `$${formatMoney(data.adr, 0)} MXN` : "—"}
          sinDato={data?.adr == null ? sinDato : undefined}
        />
        <StatCard
          icon={TrendingUp}
          label="RevPAR"
          value={data?.revpar != null ? `$${formatMoney(data.revpar, 0)} MXN` : "—"}
          sinDato={data?.revpar == null ? sinDato : undefined}
        />
        <StatCard
          icon={CalendarCheck}
          label="Reservas hoy"
          value={data?.reservasHoy != null ? String(data.reservasHoy) : "—"}
          sinDato={data?.reservasHoy == null ? sinDato : undefined}
        />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden="true" /> Valor generado por agentes de IA
          </CardTitle>
        </CardHeader>
        <CardContent>
          {roi.isError || !hotelActivoId ? (
            <p className="text-sm text-muted-foreground">Sin conexión con el API.</p>
          ) : roi.isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : !roi.data || roi.data.sinDatos ? (
            <p className="text-sm text-muted-foreground">Sin datos todavía: ningún agente ha registrado un evento de ROI este período.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-2xl font-semibold text-foreground">
                ${formatMoney(roi.data.sumaEstimadoUsd)} USD{" "}
                <Badge variant="secondary" className="align-middle ml-1">
                  estimado, supuestos {roi.data.supuestoVersion}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">
                {roi.data.eventos.length} evento(s) registrado(s)
                {roi.data.sumaVerificadoUsd > 0 ? ` · $${formatMoney(roi.data.sumaVerificadoUsd)} USD ya verificado contra línea base` : ""}.
                Cifra sin línea base firmada todavía (REQ-REV-018): no habilita ningún cobro por resultado.
              </p>
              <Link to="/agentes" className="text-xs text-primary underline underline-offset-2">
                Ver supuestos de la fórmula (H17) y el detalle por agente →
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
