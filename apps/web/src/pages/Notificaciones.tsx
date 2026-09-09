// H12c · LAUNCH-017: lista completa de notificaciones + preferencias por usuario.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { Button, Card, CardHeader, CardTitle, CardContent, EstadoError, EstadoVacio, Badge, Separator } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { useHotel } from "../hooks/useHotel";
import {
  listarNotificaciones,
  marcarNotificacionLeida,
  marcarTodasNotificacionesLeidas,
  listarPreferenciasNotificacion,
  actualizarPreferenciaNotificacion,
  type TipoNotificacion,
} from "../lib/api";
import { track } from "../lib/analytics";

const ETIQUETAS_TIPO: Record<TipoNotificacion, string> = {
  reserva_nueva: "Reserva nueva",
  aprobacion_pendiente: "Aprobación pendiente",
  ticket_urgente: "Ticket urgente",
  night_audit_cerrado: "Night audit cerrado",
  limite_plan: "Límite de plan",
  sistema: "Sistema",
};

export function Notificaciones() {
  const { hotelActivoId } = useHotel();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["notificaciones-lista", hotelActivoId],
    queryFn: () => listarNotificaciones(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const preferenciasQuery = useQuery({
    queryKey: ["notificaciones-preferencias"],
    queryFn: () => listarPreferenciasNotificacion(),
    retry: false,
  });

  if (query.isError) {
    return (
      <div>
        <PageHeader titulo="Notificaciones" descripcion="Avisos de reservas, aprobaciones, tickets urgentes y límites de plan." />
        <EstadoError titulo="Sin conexión con el API" mensaje="No se pudieron cargar las notificaciones." onReintentar={() => query.refetch()} />
      </div>
    );
  }

  const notificaciones = query.data ?? [];
  const hayNoLeidas = notificaciones.some((n) => !n.leidaEn);
  const preferenciaActiva = (tipo: TipoNotificacion) => preferenciasQuery.data?.find((p) => p.tipo === tipo)?.activa ?? true;

  return (
    <div>
      <PageHeader
        titulo="Notificaciones"
        descripcion="Avisos de reservas, aprobaciones, tickets urgentes, night audit y límites de plan."
        accion={
          <Button
            variant="outline"
            size="sm"
            disabled={!hayNoLeidas}
            onClick={async () => {
              track("notification_marked_all_read");
              await marcarTodasNotificacionesLeidas(hotelActivoId as string);
              await queryClient.invalidateQueries({ queryKey: ["notificaciones-lista", hotelActivoId] });
              await queryClient.invalidateQueries({ queryKey: ["notificaciones-conteo", hotelActivoId] });
            }}
          >
            <CheckCheck className="size-4 mr-1.5" aria-hidden="true" /> Marcar todo como leído
          </Button>
        }
      />

      {notificaciones.length === 0 ? (
        <EstadoVacio titulo="Sin notificaciones todavía" mensaje="Aquí aparecerán los avisos importantes de tu operación." />
      ) : (
        <div className="space-y-2" aria-busy={query.isLoading}>
          {notificaciones.map((n) => (
            <Card key={n.id} className={n.leidaEn ? "opacity-70" : undefined}>
              <CardContent className="py-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={n.leidaEn ? "secondary" : "default"}>{ETIQUETAS_TIPO[n.tipo]}</Badge>
                    <span className="font-medium text-sm">{n.titulo}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{n.cuerpo}</p>
                  <p className="text-xs text-muted-foreground mt-1">{new Date(n.creadaEn).toLocaleString("es-MX")}</p>
                </div>
                {!n.leidaEn && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await marcarNotificacionLeida(hotelActivoId as string, n.id);
                      await queryClient.invalidateQueries({ queryKey: ["notificaciones-lista", hotelActivoId] });
                      await queryClient.invalidateQueries({ queryKey: ["notificaciones-conteo", hotelActivoId] });
                    }}
                  >
                    Marcar leída
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Preferencias</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Desactiva un tipo de aviso si no quieres seguir recibiéndolo en la campana del panel.
          </p>
          <Separator />
          {(Object.keys(ETIQUETAS_TIPO) as TipoNotificacion[]).map((tipo) => (
            <div key={tipo} className="flex items-center justify-between text-sm">
              <span>{ETIQUETAS_TIPO[tipo]}</span>
              <Button
                variant={preferenciaActiva(tipo) ? "default" : "outline"}
                size="sm"
                onClick={async () => {
                  await actualizarPreferenciaNotificacion(tipo, !preferenciaActiva(tipo));
                  await queryClient.invalidateQueries({ queryKey: ["notificaciones-preferencias"] });
                }}
              >
                {preferenciaActiva(tipo) ? "Activada" : "Desactivada"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
