import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DoorOpen, DoorClosed } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Card, CardHeader, CardTitle, CardContent, Label } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { FolioPanel } from "../components/folio/FolioPanel";
import { useHotel } from "../hooks/useHotel";
import { listarMovimientosRecepcion, listarReservas, type RecepcionMovimiento, type Reserva } from "../lib/api";

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

      {hotelActivoId && <SeccionFolioHuesped hotelId={hotelActivoId} />}

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

/** H5 · folio del huésped en casa: buscar/seleccionar una reserva con folio y operar
 *  cargos/pagos/descuentos/reverso/cierre sobre él (REQ-REC-004/012, REQ-BO-001). */
function SeccionFolioHuesped({ hotelId }: { hotelId: string }) {
  const [reservationId, setReservationId] = useState<string>("");
  const query = useQuery({
    queryKey: ["reservas-con-folio", hotelId],
    queryFn: () => listarReservas(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  const reservasConFolio = (query.data ?? []).filter((r: Reserva) => r.folioId);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Folio del huésped en casa</CardTitle>
      </CardHeader>
      <CardContent>
        <DataState
          isLoading={query.isLoading}
          error={query.error}
          data={reservasConFolio}
          mensajeVacio="No hay reservas con folio todavía (se crea al confirmar la reserva)."
          onReintentar={() => query.refetch()}
        >
          {() => (
            <div className="space-y-4">
              <div>
                <Label htmlFor="folio-reserva-select">Reserva</Label>
                <select
                  id="folio-reserva-select"
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={reservationId}
                  onChange={(e) => setReservationId(e.target.value)}
                >
                  <option value="">Selecciona una reserva…</option>
                  {reservasConFolio.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.huesped} · {r.habitacion} · {r.llegada} → {r.salida} · {r.estado}
                    </option>
                  ))}
                </select>
              </div>
              {reservationId && <FolioPanel hotelId={hotelId} reservationId={reservationId} />}
            </div>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
