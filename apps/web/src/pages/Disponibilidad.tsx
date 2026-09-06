import { useQuery } from "@tanstack/react-query";
import { BedDouble } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarDisponibilidad, type DisponibilidadFila } from "../lib/api";

export function Disponibilidad() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["disponibilidad", hotelActivoId],
    queryFn: () => listarDisponibilidad(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const totalDisponibles = query.data?.reduce((acc, f) => acc + f.disponibles, 0);

  return (
    <div>
      <PageHeader titulo="Disponibilidad" descripcion="Habitaciones disponibles por tipo para hoy y tarifario vigente." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard
          icon={BedDouble}
          label="Habitaciones disponibles hoy"
          value={totalDisponibles != null ? String(totalDisponibles) : "—"}
          sinDato={totalDisponibles == null ? "Pendiente de credenciales del PMS." : undefined}
        />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay tipos de habitación configurados todavía para este hotel."
        onReintentar={() => query.refetch()}
      >
        {(filas: DisponibilidadFila[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo de habitación</TableHead>
                  <TableHead className="text-right">Disponibles</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Tarifa desde</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filas.map((f) => (
                  <TableRow key={f.tipoHabitacion}>
                    <TableCell className="font-medium">{f.tipoHabitacion}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.disponibles}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.total}</TableCell>
                    <TableCell className="text-right tabular-nums">${f.tarifaDesde.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DataState>
    </div>
  );
}
