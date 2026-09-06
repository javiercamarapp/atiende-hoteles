import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, DoorOpen, DoorClosed, Plus } from "lucide-react";
import {
  StatCard,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  formatMoney,
} from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  listarReservas,
  listarDisponibilidad,
  crearReserva,
  cancelarReserva,
  modificarReserva,
  obtenerReserva,
  ApiUnavailableError,
  type Reserva,
} from "../lib/api";

// Roles que la RLS/middleware de apps/api (MANAGE_RESERVATIONS_ROLES) autoriza a
// crear/modificar/cancelar reservas -- solo controla qué botones se muestran; la
// autorización real e irrenunciable sigue siendo del backend (doble capa).
const ROLES_GESTION_RESERVAS = ["owner", "gm", "frontdesk", "reservations"];

const ETIQUETAS_ESTADO: Record<string, { texto: string; variante: "default" | "secondary" | "destructive" | "outline" }> = {
  cotizada: { texto: "Cotizada", variante: "outline" },
  confirmada: { texto: "Confirmada", variante: "default" },
  check_in: { texto: "Check-in", variante: "secondary" },
  en_estancia: { texto: "En estancia", variante: "secondary" },
  check_out: { texto: "Check-out", variante: "secondary" },
  cerrada: { texto: "Cerrada", variante: "outline" },
  cancelada: { texto: "Cancelada", variante: "destructive" },
  no_show: { texto: "No-show", variante: "destructive" },
};

function EstadoBadge({ estado }: { estado: string }) {
  const info = ETIQUETAS_ESTADO[estado] ?? { texto: estado, variante: "outline" as const };
  return <Badge variant={info.variante}>{info.texto}</Badge>;
}

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Reservas() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const puedeGestionar = Boolean(sesion && ROLES_GESTION_RESERVAS.includes(sesion.rol));

  const [filtroTexto, setFiltroTexto] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [reservaSeleccionadaId, setReservaSeleccionadaId] = useState<string | null>(null);
  const [dialogCrearAbierto, setDialogCrearAbierto] = useState(false);

  const query = useQuery({
    queryKey: ["reservas", hotelActivoId],
    queryFn: () => listarReservas(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const reservasFiltradas = useMemo(() => {
    if (!query.data) return undefined;
    return query.data.filter((r) => {
      const coincideEstado = filtroEstado === "todos" || r.estado === filtroEstado;
      const texto = filtroTexto.trim().toLowerCase();
      const coincideTexto =
        texto.length === 0 ||
        r.huesped.toLowerCase().includes(texto) ||
        r.habitacion.toLowerCase().includes(texto) ||
        (r.codigoConfirmacion ?? "").toLowerCase().includes(texto);
      return coincideEstado && coincideTexto;
    });
  }, [query.data, filtroTexto, filtroEstado]);

  const total = query.data?.length;
  const checkinsHoy = query.data?.filter((r) => r.estado === "confirmada").length;
  const checkoutsHoy = query.data?.filter((r) => r.estado === "en_estancia").length;

  return (
    <div>
      <PageHeader
        titulo="Reservas"
        descripcion="Reservas por canal, fechas de estancia y estado."
        accion={
          puedeGestionar && (
            <Button onClick={() => setDialogCrearAbierto(true)}>
              <Plus className="size-4 mr-1.5" /> Nueva reserva
            </Button>
          )
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard icon={CalendarCheck} label="Reservas totales" value={total != null ? String(total) : "—"} sinDato={total == null ? "Pendiente de conexión con la API." : undefined} />
        <StatCard icon={DoorOpen} label="Confirmadas" value={checkinsHoy != null ? String(checkinsHoy) : "—"} sinDato={checkinsHoy == null ? "Pendiente de conexión con la API." : undefined} />
        <StatCard icon={DoorClosed} label="En estancia" value={checkoutsHoy != null ? String(checkoutsHoy) : "—"} sinDato={checkoutsHoy == null ? "Pendiente de conexión con la API." : undefined} />
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex-1">
          <Label htmlFor="filtro-reservas" className="sr-only">
            Buscar por huésped, habitación o código
          </Label>
          <Input
            id="filtro-reservas"
            placeholder="Buscar por huésped, habitación o código de confirmación…"
            value={filtroTexto}
            onChange={(e) => setFiltroTexto(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="filtro-estado" className="sr-only">
            Filtrar por estado
          </Label>
          <select
            id="filtro-estado"
            className="h-11 rounded-md border border-input bg-background px-3 text-sm"
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
          >
            <option value="todos">Todos los estados</option>
            {Object.entries(ETIQUETAS_ESTADO).map(([valor, info]) => (
              <option key={valor} value={valor}>
                {info.texto}
              </option>
            ))}
          </select>
        </div>
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={reservasFiltradas}
        esVacio={(data) => data.length === 0}
        mensajeVacio={query.data && query.data.length > 0 ? "Ningún resultado coincide con el filtro." : "No hay reservas registradas todavía para este hotel."}
        onReintentar={() => query.refetch()}
      >
        {(reservas: Reserva[]) => (
          <div className="rounded-xl border border-border overflow-x-auto">
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
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/40"
                    tabIndex={0}
                    role="button"
                    aria-label={`Ver detalle de la reserva de ${r.huesped}`}
                    onClick={() => setReservaSeleccionadaId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setReservaSeleccionadaId(r.id);
                    }}
                  >
                    <TableCell className="font-medium">{r.huesped}</TableCell>
                    <TableCell>{r.llegada}</TableCell>
                    <TableCell>{r.salida}</TableCell>
                    <TableCell>{r.habitacion}</TableCell>
                    <TableCell>{r.canal}</TableCell>
                    <TableCell>
                      <EstadoBadge estado={r.estado} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">${formatMoney(r.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DataState>

      {dialogCrearAbierto && (
        <DialogoNuevaReserva
          hotelId={hotelActivoId as string}
          onCerrar={() => setDialogCrearAbierto(false)}
          onCreada={() => {
            setDialogCrearAbierto(false);
            queryClient.invalidateQueries({ queryKey: ["reservas", hotelActivoId] });
          }}
        />
      )}

      <Sheet open={Boolean(reservaSeleccionadaId)} onOpenChange={(abierto) => !abierto && setReservaSeleccionadaId(null)}>
        {reservaSeleccionadaId && (
          <PanelDetalleReserva
            hotelId={hotelActivoId as string}
            reservationId={reservaSeleccionadaId}
            puedeGestionar={puedeGestionar}
            onCerrar={() => setReservaSeleccionadaId(null)}
            onCambio={() => queryClient.invalidateQueries({ queryKey: ["reservas", hotelActivoId] })}
          />
        )}
      </Sheet>
    </div>
  );
}

function DialogoNuevaReserva({ hotelId, onCerrar, onCreada }: { hotelId: string; onCerrar: () => void; onCreada: () => void }) {
  const disponibilidadQuery = useQuery({
    queryKey: ["disponibilidad-resumen", hotelId],
    queryFn: () => listarDisponibilidad(hotelId),
  });

  const [roomTypeId, setRoomTypeId] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);

  const mutacion = useMutation({
    mutationFn: () => crearReserva(hotelId, { roomTypeId, checkInDate, checkOutDate }),
    onSuccess: onCreada,
    onError: (err) => setErrorEnvio(mensajeError(err)),
  });

  const formValido = Boolean(roomTypeId && checkInDate && checkOutDate && checkOutDate > checkInDate);

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva reserva</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setErrorEnvio(null);
            mutacion.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="nueva-reserva-tipo">Tipo de habitación</Label>
            <select
              id="nueva-reserva-tipo"
              required
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={roomTypeId}
              onChange={(e) => setRoomTypeId(e.target.value)}
            >
              <option value="" disabled>
                Selecciona un tipo de habitación
              </option>
              {disponibilidadQuery.data?.map((f) => (
                <option key={f.tipoHabitacionId} value={f.tipoHabitacionId}>
                  {f.tipoHabitacion}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="nueva-reserva-llegada">Llegada</Label>
              <Input
                id="nueva-reserva-llegada"
                type="date"
                required
                value={checkInDate}
                onChange={(e) => setCheckInDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nueva-reserva-salida">Salida</Label>
              <Input
                id="nueva-reserva-salida"
                type="date"
                required
                min={checkInDate || undefined}
                value={checkOutDate}
                onChange={(e) => setCheckOutDate(e.target.value)}
              />
            </div>
          </div>

          {errorEnvio && (
            <p role="alert" className="text-sm text-destructive">
              {errorEnvio}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCerrar}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!formValido || mutacion.isPending}>
              {mutacion.isPending ? "Creando…" : "Crear reserva"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PanelDetalleReserva({
  hotelId,
  reservationId,
  puedeGestionar,
  onCerrar,
  onCambio,
}: {
  hotelId: string;
  reservationId: string;
  puedeGestionar: boolean;
  onCerrar: () => void;
  onCambio: () => void;
}) {
  const detalleQuery = useQuery({
    queryKey: ["reserva-detalle", hotelId, reservationId],
    queryFn: () => obtenerReserva(hotelId, reservationId),
  });

  const [modoModificar, setModoModificar] = useState(false);
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  const cancelarMutacion = useMutation({
    mutationFn: () => cancelarReserva(hotelId, reservationId),
    onSuccess: () => {
      onCambio();
      detalleQuery.refetch();
    },
    onError: (err) => setErrorAccion(mensajeError(err)),
  });

  const modificarMutacion = useMutation({
    mutationFn: () => modificarReserva(hotelId, reservationId, { checkInDate, checkOutDate }),
    onSuccess: () => {
      onCambio();
      setModoModificar(false);
      detalleQuery.refetch();
    },
    onError: (err) => setErrorAccion(mensajeError(err)),
  });

  const esModificable = detalleQuery.data && ["cotizada", "confirmada"].includes(detalleQuery.data.estado);

  return (
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Detalle de la reserva</SheetTitle>
      </SheetHeader>

      <DataState
        isLoading={detalleQuery.isLoading}
        error={detalleQuery.error}
        data={detalleQuery.data}
        mensajeVacio="No se encontró la reserva."
        onReintentar={() => detalleQuery.refetch()}
      >
        {(r: Reserva) => (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Estado</span>
              <EstadoBadge estado={r.estado} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Huésped</span>
              <span className="font-medium">{r.huesped}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Habitación</span>
              <span className="font-medium">{r.habitacion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Llegada</span>
              <span className="font-medium tabular-nums">{r.llegada}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Salida</span>
              <span className="font-medium tabular-nums">{r.salida}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Canal</span>
              <span className="font-medium">{r.canal}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium tabular-nums">${formatMoney(r.total)}</span>
            </div>
            {r.codigoConfirmacion && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Código de confirmación</span>
                <span className="font-mono font-medium">{r.codigoConfirmacion}</span>
              </div>
            )}

            {errorAccion && (
              <p role="alert" className="text-sm text-destructive">
                {errorAccion}
              </p>
            )}

            {puedeGestionar && esModificable && !modoModificar && (
              <div className="flex flex-col gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCheckInDate(r.llegada);
                    setCheckOutDate(r.salida);
                    setModoModificar(true);
                  }}
                >
                  Modificar fechas
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setErrorAccion(null);
                    cancelarMutacion.mutate();
                  }}
                  disabled={cancelarMutacion.isPending}
                >
                  {cancelarMutacion.isPending ? "Cancelando…" : "Cancelar reserva"}
                </Button>
              </div>
            )}

            {puedeGestionar && modoModificar && (
              <form
                className="space-y-3 pt-2 border-t border-border"
                onSubmit={(e) => {
                  e.preventDefault();
                  setErrorAccion(null);
                  modificarMutacion.mutate();
                }}
              >
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="modificar-llegada">Nueva llegada</Label>
                    <Input id="modificar-llegada" type="date" required value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="modificar-salida">Nueva salida</Label>
                    <Input
                      id="modificar-salida"
                      type="date"
                      required
                      min={checkInDate || undefined}
                      value={checkOutDate}
                      onChange={(e) => setCheckOutDate(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setModoModificar(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={modificarMutacion.isPending || checkOutDate <= checkInDate}>
                    {modificarMutacion.isPending ? "Guardando…" : "Guardar fechas"}
                  </Button>
                </div>
              </form>
            )}

            {!esModificable && puedeGestionar && (
              <p className="text-xs text-muted-foreground pt-2 border-t border-border">
                Esta reserva ya no admite modificar fechas ni cancelarse (estado actual: {r.estado}).
              </p>
            )}
          </div>
        )}
      </DataState>

      <Button variant="ghost" className="mt-6 w-full" onClick={onCerrar}>
        Cerrar
      </Button>
    </SheetContent>
  );
}
