import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, DoorOpen, DoorClosed } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarReservas, type Reserva } from "../lib/api";

export function Reservas() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["reservas", hotelActivoId],
    queryFn: () => listarReservas(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const total = query.data?.length;
  const checkinsHoy = query.data?.filter((r) => r.estado === "check-in-hoy").length;

  return (
    <div>
      <PageHeader titulo="Reservas" descripcion="Reservas confirmadas por canal (OTA/directo), fechas de estancia y estado de pago." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard icon={CalendarCheck} label="Reservas totales" value={total != null ? String(total) : "—"} sinDato={total == null ? "Pendiente de credenciales del PMS." : undefined} />
        <StatCard icon={DoorOpen} label="Check-ins hoy" value={checkinsHoy != null ? String(checkinsHoy) : "—"} sinDato={checkinsHoy == null ? "Pendiente de credenciales del PMS." : undefined} />
        <StatCard icon={DoorClosed} label="Check-outs hoy" value="—" sinDato="Pendiente de credenciales del PMS." />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay reservas registradas todavía para este hotel."
        onReintentar={() => query.refetch()}
      >
        {(reservas: Reserva[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Huésped</TableHead>
                  <TableHead>Llegada</TableHead>
                  <TableHead>Salida</TableHead>
                  <TableHead>Habitación</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reservas.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.huesped}</TableCell>
                    <TableCell>{r.llegada}</TableCell>
                    <TableCell>{r.salida}</TableCell>
                    <TableCell>{r.habitacion}</TableCell>
                    <TableCell>{r.canal}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{r.estado}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">${r.total.toFixed(2)}</TableCell>
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
