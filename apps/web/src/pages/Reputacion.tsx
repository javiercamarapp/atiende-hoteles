import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarResenas, type ResenaReputacion } from "../lib/api";

export function Reputacion() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["reputacion", hotelActivoId],
    queryFn: () => listarResenas(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const sinResponder = query.data?.filter((r) => !r.respondida).length;
  const promedio = query.data?.length ? query.data.reduce((acc, r) => acc + r.calificacion, 0) / query.data.length : undefined;

  return (
    <div>
      <PageHeader titulo="Reputación" descripcion="Reseñas de Google, Booking y TripAdvisor centralizadas, con estado de respuesta." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Star} label="Calificación promedio" value={promedio != null ? promedio.toFixed(1) : "—"} sinDato={promedio == null ? "Integración con Google/Booking/TripAdvisor pendiente." : undefined} />
        <StatCard icon={Star} label="Sin responder" value={sinResponder != null ? String(sinResponder) : "—"} sinDato={sinResponder == null ? "Integración con Google/Booking/TripAdvisor pendiente." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay reseñas registradas todavía."
        onReintentar={() => query.refetch()}
      >
        {(resenas: ResenaReputacion[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Huésped</TableHead>
                  <TableHead>Fuente</TableHead>
                  <TableHead className="text-right">Calificación</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resenas.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.huesped}</TableCell>
                    <TableCell>{r.fuente}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.calificacion.toFixed(1)}</TableCell>
                    <TableCell>{r.respondida ? <Badge variant="secondary">Respondida</Badge> : <Badge variant="destructive">Sin responder</Badge>}</TableCell>
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
