import { useQuery } from "@tanstack/react-query";
import { DoorOpen, DoorClosed } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarMovimientosRecepcion, type RecepcionMovimiento } from "../lib/api";

export function Recepcion() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["recepcion", hotelActivoId],
    queryFn: () => listarMovimientosRecepcion(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const checkins = query.data?.filter((m) => m.tipo === "check-in").length;
  const checkouts = query.data?.filter((m) => m.tipo === "check-out").length;

  return (
    <div>
      <PageHeader titulo="Recepción" descripcion="Movimientos de check-in y check-out del turno, con estado en tiempo real." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={DoorOpen} label="Check-ins pendientes" value={checkins != null ? String(checkins) : "—"} sinDato={checkins == null ? "Pendiente de credenciales del PMS." : undefined} />
        <StatCard icon={DoorClosed} label="Check-outs pendientes" value={checkouts != null ? String(checkouts) : "—"} sinDato={checkouts == null ? "Pendiente de credenciales del PMS." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay movimientos de recepción registrados en este turno."
        onReintentar={() => query.refetch()}
      >
        {(movimientos: RecepcionMovimiento[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Huésped</TableHead>
                  <TableHead>Habitación</TableHead>
                  <TableHead>Movimiento</TableHead>
                  <TableHead>Hora</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movimientos.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.huesped}</TableCell>
                    <TableCell>{m.habitacion}</TableCell>
                    <TableCell>{m.tipo === "check-in" ? "Check-in" : "Check-out"}</TableCell>
                    <TableCell>{m.hora}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{m.estado}</Badge>
                    </TableCell>
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
