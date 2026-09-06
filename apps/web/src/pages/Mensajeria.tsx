// H6b · Bandeja de conversaciones de WhatsApp real (REQ-HUE-001/002, H09) sobre
// FakeWhatsappAdapter: cada mensaje muestra su estado de entrega "simulado" cuando el
// adaptador todavía no tiene credenciales reales de Meta (ADR-007), nunca aparenta una
// entrega real que no ocurrió. Enviar una plantilla no transaccional queda "pendiente de
// aprobación" -- se completa desde la bandeja de /aprobaciones (badge del encabezado).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, Settings2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, StatCard } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  ApiUnavailableError,
  actualizarConfigMensajeria,
  enviarMensajeWhatsapp,
  listarConversaciones,
  listarMensajesConversacion,
  obtenerConfigMensajeria,
  type ConversacionMensaje,
  type HiloMensaje,
} from "../lib/api";

const ADMIN_ROLES = ["owner", "gm"];

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Mensajeria() {
  const { hotelActivoId } = useHotel();
  const queryClient = useQueryClient();
  const [conversacionAbierta, setConversacionAbierta] = useState<string | null>(null);
  const [nuevoMensaje, setNuevoMensaje] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["mensajeria", hotelActivoId],
    queryFn: () => listarConversaciones(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const hilo = useQuery({
    queryKey: ["mensajeria-hilo", hotelActivoId, conversacionAbierta],
    queryFn: () => listarMensajesConversacion(hotelActivoId as string, conversacionAbierta as string),
    enabled: Boolean(hotelActivoId && conversacionAbierta),
    retry: false,
  });

  const enviar = useMutation({
    mutationFn: (input: { guestPhone: string; templateName: string; parameters: string[] }) =>
      enviarMensajeWhatsapp(hotelActivoId as string, input),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["mensajeria", hotelActivoId] });
      setNuevoMensaje(false);
      setAviso(
        res.estado === "enviado"
          ? "Mensaje enviado (simulado, sin credenciales reales de Meta)."
          : "Mensaje pendiente de aprobación humana antes de enviarse — revisa la bandeja de aprobaciones.",
      );
    },
    onError: (err) => setError(mensajeError(err)),
  });

  return (
    <div>
      <PageHeader titulo="Mensajería" descripcion="Conversaciones de WhatsApp con huéspedes (adaptador simulado, sin credenciales reales de Meta)." accion={<Button onClick={() => setNuevoMensaje(true)}><Send /> Enviar plantilla</Button>} />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {aviso && (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          {aviso}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={MessageCircle} label="Conversaciones activas" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "Sin datos todavía." : undefined} />
      </div>

      <ConfigPlantillasTransaccionales />

      <DataState isLoading={query.isLoading} error={query.error} data={query.data} mensajeVacio="No hay conversaciones activas." onReintentar={() => query.refetch()}>
        {(conversaciones: ConversacionMensaje[]) => (
          <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
            {conversaciones.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setConversacionAbierta(c.id)}
                className="w-full text-left px-4 py-3 min-h-11 hover:bg-muted transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{c.huesped}</p>
                  <p className="text-sm text-muted-foreground truncate">{c.ultimoMensaje}</p>
                </div>
                <Badge variant="secondary" className="capitalize shrink-0">
                  {c.canal}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </DataState>

      <Dialog open={conversacionAbierta !== null} onOpenChange={(open) => !open && setConversacionAbierta(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Conversación</DialogTitle>
          </DialogHeader>
          <DataState isLoading={hilo.isLoading} error={hilo.error} data={hilo.data} mensajeVacio="Sin mensajes en esta conversación." onReintentar={() => hilo.refetch()}>
            {(mensajes: HiloMensaje[]) => (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {mensajes.map((m) => (
                  <div key={m.id} className={`rounded-lg px-3 py-2 text-sm max-w-[85%] ${m.direccion === "saliente" ? "ml-auto bg-primary/10" : "bg-muted"}`}>
                    <p>{m.texto}</p>
                    <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
                      {m.estadoEntrega && <span className="capitalize">{m.estadoEntrega}</span>}
                      {m.simulado && <Badge variant="secondary">simulado</Badge>}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </DialogContent>
      </Dialog>

      <Dialog open={nuevoMensaje} onOpenChange={setNuevoMensaje}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar plantilla de WhatsApp</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const parametro = String(form.get("parametro") ?? "").trim();
              enviar.mutate({
                guestPhone: String(form.get("guestPhone") ?? "").trim(),
                templateName: String(form.get("templateName") ?? "").trim(),
                parameters: parametro ? [parametro] : [],
              });
            }}
          >
            <p className="text-xs text-muted-foreground">
              Las plantillas configuradas como "transaccionales" (Configuración) se envían sin espera humana; cualquier
              otra queda pendiente de aprobación.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="msg-phone">Teléfono del huésped (E.164)</Label>
              <Input id="msg-phone" name="guestPhone" placeholder="+5215500000000" required minLength={8} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="msg-template">Nombre de la plantilla</Label>
              <Input id="msg-template" name="templateName" placeholder="checkin_confirmado" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="msg-param">Parámetro (opcional)</Label>
              <Input id="msg-param" name="parametro" placeholder="Nombre del huésped" />
            </div>
            <Button type="submit" className="w-full" disabled={enviar.isPending}>
              Enviar
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Solo owner/gm pueden decidir qué plantillas se envían SIN espera humana (GOB-026: la
 * tool de WhatsApp siempre exige needsApproval, esto solo controla la auto-aprobación por
 * configuración del hotel, ver agent-core `createTransactionalTemplateApprovalQueue`). */
function ConfigPlantillasTransaccionales() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const [valor, setValor] = useState("");
  const [guardado, setGuardado] = useState(false);
  const esAdmin = Boolean(sesion && ADMIN_ROLES.includes(sesion.rol));

  const query = useQuery({
    queryKey: ["mensajeria-config", hotelActivoId],
    queryFn: () => obtenerConfigMensajeria(hotelActivoId as string),
    enabled: Boolean(hotelActivoId) && esAdmin,
    retry: false,
  });

  const guardar = useMutation({
    mutationFn: (plantillas: string[]) => actualizarConfigMensajeria(hotelActivoId as string, plantillas),
    onSuccess: () => {
      setGuardado(true);
      queryClient.invalidateQueries({ queryKey: ["mensajeria-config", hotelActivoId] });
    },
  });

  if (!esAdmin) return null;

  const actuales = query.data?.plantillasTransaccionales ?? [];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 className="size-4" aria-hidden="true" /> Plantillas transaccionales
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Estas plantillas se envían sin esperar aprobación humana (confirmación de reserva, recordatorio de checkin).
          Cualquier otra plantilla siempre requiere aprobación.
        </p>
        {actuales.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {actuales.map((p) => (
              <Badge key={p} variant="secondary">
                {p}
              </Badge>
            ))}
          </div>
        )}
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setGuardado(false);
            const plantillas = valor
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            guardar.mutate(plantillas.length > 0 ? plantillas : actuales);
            setValor("");
          }}
        >
          <Label htmlFor="msg-config-templates" className="sr-only">
            Agregar plantillas transaccionales (separadas por coma)
          </Label>
          <Input id="msg-config-templates" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="checkin_confirmado, recordatorio_checkin" className="flex-1" />
          <Button type="submit" disabled={guardar.isPending}>
            Guardar
          </Button>
        </form>
        {guardado && <p className="mt-2 text-xs text-muted-foreground">Guardado.</p>}
      </CardContent>
    </Card>
  );
}
