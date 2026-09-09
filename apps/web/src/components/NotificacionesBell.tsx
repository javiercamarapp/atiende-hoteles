// H12c · LAUNCH-017: campana de notificaciones del header, mismo criterio que
// AprobacionesBadge (conteo REAL, nunca inventado; re-consulta cada 20s). Abre un
// desplegable con las últimas notificaciones y "marcar todo como leído" (atómico,
// una sola llamada -- ver POST .../notificaciones/marcar-todo-leido).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, CheckCheck } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@atiende/ui";
import { useHotel } from "../hooks/useHotel";
import { contarNotificacionesNoLeidas, listarNotificaciones, marcarNotificacionLeida, marcarTodasNotificacionesLeidas } from "../lib/api";
import { track } from "../lib/analytics";

export function NotificacionesBell() {
  const { hotelActivoId } = useHotel();
  const queryClient = useQueryClient();

  const conteoQuery = useQuery({
    queryKey: ["notificaciones-conteo", hotelActivoId],
    queryFn: () => contarNotificacionesNoLeidas(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
    refetchInterval: 20_000,
  });

  const listaQuery = useQuery({
    queryKey: ["notificaciones-lista", hotelActivoId],
    queryFn: () => listarNotificaciones(hotelActivoId as string),
    enabled: false, // se dispara al abrir el desplegable (evita una consulta extra cada 20s solo para el badge)
    retry: false,
  });

  const conteo = conteoQuery.data ?? 0;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          track("notification_opened");
          void listaQuery.refetch();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={conteo > 0 ? `${conteo} notificaciones sin leer` : "Notificaciones"}
          className="relative inline-flex items-center justify-center min-h-11 min-w-11 rounded-full border border-border bg-card hover:bg-muted transition-colors"
        >
          <Bell className="size-5" aria-hidden="true" />
          {conteo > 0 && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground">
              {conteo > 99 ? "99+" : conteo}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notificaciones</DropdownMenuLabel>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={conteo === 0}
            onClick={async (e) => {
              e.preventDefault();
              track("notification_marked_all_read");
              await marcarTodasNotificacionesLeidas(hotelActivoId as string);
              await queryClient.invalidateQueries({ queryKey: ["notificaciones-conteo", hotelActivoId] });
              await listaQuery.refetch();
            }}
          >
            <CheckCheck className="size-3.5" aria-hidden="true" /> Marcar todo leído
          </Button>
        </div>
        <DropdownMenuSeparator />
        {!listaQuery.data || listaQuery.data.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Sin notificaciones todavía.</p>
        ) : (
          listaQuery.data.slice(0, 8).map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="flex flex-col items-start gap-0.5 whitespace-normal py-2"
              onSelect={async () => {
                if (!n.leidaEn) {
                  await marcarNotificacionLeida(hotelActivoId as string, n.id);
                  await queryClient.invalidateQueries({ queryKey: ["notificaciones-conteo", hotelActivoId] });
                }
              }}
            >
              <span className={`text-sm ${n.leidaEn ? "text-muted-foreground" : "font-medium text-foreground"}`}>{n.titulo}</span>
              <span className="text-xs text-muted-foreground">{n.cuerpo}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/notificaciones" className="text-sm text-primary">
            Ver todas
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
