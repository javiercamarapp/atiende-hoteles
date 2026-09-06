// H6b · Tablero real de housekeeping (REQ-HK-001/002/003/020, REQ-UX-001/003): mobile-first
// (390px), botones ≥44px (Button de @atiende/ui ya cumple h-11), tarjetas apiladas en vez
// de tabla para no forzar scroll horizontal en pantalla angosta. "Nunca inventar datos"
// (REQ-UX-002): DataState maneja carga/error/vacío; cualquier mutación que falla muestra
// el error real, nunca un éxito optimista fingido.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Plus, PlayCircle, CheckCircle2, ClipboardCheck, Ban } from "lucide-react";
import { Badge, Button, Card, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, StatCard } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  ApiUnavailableError,
  crearTareaHousekeeping,
  iniciarTareaHousekeeping,
  inspeccionarTareaHousekeeping,
  marcarFueraDeServicio,
  obtenerTableroHousekeeping,
  terminarTareaHousekeeping,
  type HabitacionTablero,
} from "../lib/api";

const SUPERVISOR_ROLES = ["owner", "gm", "frontdesk"];
const ADMIN_ROLES = ["owner", "gm"];

const ESTADO_BADGE: Record<HabitacionTablero["housekeepingStatus"], { label: string; variant: "default" | "secondary" | "destructive" }> = {
  sucia: { label: "Sucia", variant: "destructive" },
  limpia: { label: "Limpia", variant: "default" },
  inspeccionada: { label: "Inspeccionada", variant: "secondary" },
  fuera_de_servicio: { label: "Fuera de servicio", variant: "destructive" },
};

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Housekeeping() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [dialogRoomCode, setDialogRoomCode] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["housekeeping-tablero", hotelActivoId],
    queryFn: () => obtenerTableroHousekeeping(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const invalidar = () => queryClient.invalidateQueries({ queryKey: ["housekeeping-tablero", hotelActivoId] });

  const iniciar = useMutation({
    mutationFn: (taskId: string) => iniciarTareaHousekeeping(hotelActivoId as string, taskId),
    onSuccess: invalidar,
    onError: (err) => setError(mensajeError(err)),
  });
  const terminar = useMutation({
    mutationFn: (taskId: string) => terminarTareaHousekeeping(hotelActivoId as string, taskId),
    onSuccess: invalidar,
    onError: (err) => setError(mensajeError(err)),
  });
  const inspeccionar = useMutation({
    mutationFn: ({ taskId, resultado }: { taskId: string; resultado: "aprobada" | "rechazada" }) =>
      inspeccionarTareaHousekeeping(hotelActivoId as string, taskId, { resultado }),
    onSuccess: invalidar,
    onError: (err) => setError(mensajeError(err)),
  });
  const fueraDeServicio = useMutation({
    mutationFn: ({ roomId, valor }: { roomId: string; valor: boolean }) => marcarFueraDeServicio(hotelActivoId as string, roomId, valor),
    onSuccess: invalidar,
    onError: (err) => setError(mensajeError(err)),
  });
  const crearTarea = useMutation({
    mutationFn: (roomCode: string) => crearTareaHousekeeping(hotelActivoId as string, { roomCode, priority: "media" }),
    onSuccess: () => {
      invalidar();
      setDialogRoomCode(null);
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const esSupervisor = Boolean(sesion && SUPERVISOR_ROLES.includes(sesion.rol));
  const esAdmin = Boolean(sesion && ADMIN_ROLES.includes(sesion.rol));

  const conteos = query.data?.reduce(
    (acc, h) => {
      acc[h.housekeepingStatus] = (acc[h.housekeepingStatus] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div>
      <PageHeader
        titulo="Housekeeping"
        descripcion="Tablero de habitaciones por estado de limpieza, asignación y ciclo de la tarea (inicio → término → inspección)."
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Sparkles} label="Sucias" value={conteos ? String(conteos.sucia ?? 0) : "—"} sinDato={!conteos ? "Sin datos todavía." : undefined} />
        <StatCard icon={Sparkles} label="Limpias" value={conteos ? String(conteos.limpia ?? 0) : "—"} sinDato={!conteos ? "Sin datos todavía." : undefined} />
        <StatCard icon={ClipboardCheck} label="Inspeccionadas" value={conteos ? String(conteos.inspeccionada ?? 0) : "—"} sinDato={!conteos ? "Sin datos todavía." : undefined} />
        <StatCard icon={Ban} label="Fuera de servicio" value={conteos ? String(conteos.fuera_de_servicio ?? 0) : "—"} sinDato={!conteos ? "Sin datos todavía." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="Este hotel todavía no tiene habitaciones registradas."
        onReintentar={() => query.refetch()}
      >
        {(habitaciones: HabitacionTablero[]) => (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {habitaciones.map((h) => {
              const badge = ESTADO_BADGE[h.housekeepingStatus];
              // Si la tarea aparece aquí es porque la RLS de packages/db ya la dejó ver
              // (housekeeping solo ve/opera LAS SUYAS, ver 0041) -- ninguna verificación
              // adicional de rol es necesaria en el cliente para decidir mostrar el botón.
              return (
                <Card key={h.roomId}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-display text-lg font-semibold">{h.roomCode}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>

                    {h.tarea ? (
                      <div className="text-sm text-muted-foreground space-y-1">
                        <p>
                          Tarea: <span className="capitalize">{h.tarea.estado}</span> · prioridad {h.tarea.prioridad}
                        </p>
                        {h.tarea.asignadoEmail && <p>Asignada a {h.tarea.asignadoEmail}</p>}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Sin tarea abierta.</p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {h.tarea?.estado === "pendiente" && (
                        <Button size="sm" onClick={() => iniciar.mutate(h.tarea!.id)} disabled={iniciar.isPending}>
                          <PlayCircle /> Iniciar
                        </Button>
                      )}
                      {h.tarea?.estado === "en_progreso" && (
                        <Button size="sm" onClick={() => terminar.mutate(h.tarea!.id)} disabled={terminar.isPending}>
                          <CheckCircle2 /> Terminar
                        </Button>
                      )}
                      {h.tarea?.estado === "completada" && esSupervisor && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => inspeccionar.mutate({ taskId: h.tarea!.id, resultado: "aprobada" })} disabled={inspeccionar.isPending}>
                            <ClipboardCheck /> Aprobar inspección
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => inspeccionar.mutate({ taskId: h.tarea!.id, resultado: "rechazada" })} disabled={inspeccionar.isPending}>
                            Rechazar
                          </Button>
                        </>
                      )}
                      {!h.tarea && esSupervisor && (
                        <Button size="sm" variant="outline" onClick={() => setDialogRoomCode(h.roomCode)}>
                          <Plus /> Crear tarea
                        </Button>
                      )}
                      {esAdmin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => fueraDeServicio.mutate({ roomId: h.roomId, valor: h.housekeepingStatus !== "fuera_de_servicio" })}
                          disabled={fueraDeServicio.isPending}
                        >
                          {h.housekeepingStatus === "fuera_de_servicio" ? "Reactivar" : "Fuera de servicio"}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>

      <Dialog open={dialogRoomCode !== null} onOpenChange={(open) => !open && setDialogRoomCode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva tarea de housekeeping — habitación {dialogRoomCode}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (dialogRoomCode) crearTarea.mutate(dialogRoomCode);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="hk-room-code">Habitación</Label>
              <Input id="hk-room-code" value={dialogRoomCode ?? ""} disabled />
            </div>
            <Button type="submit" className="w-full" disabled={crearTarea.isPending}>
              Crear tarea
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
