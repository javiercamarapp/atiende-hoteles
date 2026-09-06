import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BedDouble, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, StatCard } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarDisponibilidad, listarDisponibilidadGrid, type DisponibilidadGridFila } from "../lib/api";

const DIAS_POR_SEMANA = 7;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function inicioSemana(offsetSemanas: number): Date {
  const hoy = new Date();
  hoy.setUTCHours(0, 0, 0, 0);
  hoy.setUTCDate(hoy.getUTCDate() + offsetSemanas * DIAS_POR_SEMANA);
  return hoy;
}

function formatoDiaCorto(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function Disponibilidad() {
  const { hotelActivoId } = useHotel();
  const [semanaOffset, setSemanaOffset] = useState(0);

  const { desde, hasta } = useMemo(() => {
    const inicio = inicioSemana(semanaOffset);
    const fin = new Date(inicio);
    fin.setUTCDate(fin.getUTCDate() + DIAS_POR_SEMANA - 1);
    return { desde: isoDate(inicio), hasta: isoDate(fin) };
  }, [semanaOffset]);

  const resumenQuery = useQuery({
    queryKey: ["disponibilidad-resumen", hotelActivoId],
    queryFn: () => listarDisponibilidad(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const gridQuery = useQuery({
    queryKey: ["disponibilidad-grid", hotelActivoId, desde, hasta],
    queryFn: () => listarDisponibilidadGrid(hotelActivoId as string, desde, hasta),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const totalDisponibles = resumenQuery.data?.reduce((acc, f) => acc + f.disponibles, 0);

  return (
    <div>
      <PageHeader titulo="Disponibilidad" descripcion="Inventario y tarifa por tipo de habitación, noche a noche." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard
          icon={BedDouble}
          label="Habitaciones disponibles hoy"
          value={totalDisponibles != null ? String(totalDisponibles) : "—"}
          sinDato={totalDisponibles == null ? "Pendiente de credenciales del PMS." : undefined}
        />
      </div>

      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm font-medium text-foreground">
          {formatoDiaCorto(desde)} — {formatoDiaCorto(hasta)}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSemanaOffset((s) => s - 1)} aria-label="Semana anterior">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSemanaOffset(0)} disabled={semanaOffset === 0}>
            Hoy
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSemanaOffset((s) => s + 1)} aria-label="Semana siguiente">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <DataState
        isLoading={gridQuery.isLoading}
        error={gridQuery.error}
        data={gridQuery.data}
        mensajeVacio="No hay tipos de habitación configurados todavía para este hotel."
        onReintentar={() => gridQuery.refetch()}
      >
        {(filas: DisponibilidadGridFila[]) => (
          <div className="rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[640px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th scope="col" className="text-left font-medium px-3 py-2 sticky left-0 bg-muted/40 min-w-[140px]">
                    Tipo de habitación
                  </th>
                  {filas[0]?.dias.map((dia) => (
                    <th key={dia.fecha} scope="col" className="text-center font-medium px-2 py-2 min-w-[92px] whitespace-nowrap">
                      {formatoDiaCorto(dia.fecha)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filas.map((fila) => (
                  <tr key={fila.tipoHabitacionId} className="border-b border-border last:border-0">
                    <th scope="row" className="text-left font-medium px-3 py-2 sticky left-0 bg-background">
                      {fila.tipoHabitacion}
                    </th>
                    {fila.dias.map((dia) => {
                      const sinCupo = (dia.disponibles ?? 0) <= 0;
                      const restringido = dia.cerradoLlegada || dia.cerradoSalida || dia.estadiaMinima > 1;
                      return (
                        <td key={dia.fecha} className="px-2 py-2 text-center align-top">
                          <div className={`font-medium tabular-nums ${sinCupo ? "text-destructive" : "text-foreground"}`}>
                            {dia.disponibles ?? "—"}/{dia.total ?? "—"}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {dia.tarifa != null ? `$${dia.tarifa.toFixed(0)}` : "—"}
                          </div>
                          {restringido && (
                            <div className="mt-0.5 flex flex-wrap justify-center gap-1 text-[10px] text-muted-foreground">
                              {dia.cerradoLlegada && <span title="Cerrado a llegadas">CTA</span>}
                              {dia.cerradoSalida && <span title="Cerrado a salidas">CTD</span>}
                              {dia.estadiaMinima > 1 && <span title="Estadía mínima">{dia.estadiaMinima}n</span>}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>
    </div>
  );
}
