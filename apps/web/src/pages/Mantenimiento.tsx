// H6b · Tickets de mantenimiento correctivo reales (REQ-HK-011/013/014). "Cerrar con
// costo" SIEMPRE abre una solicitud de doble aprobación (GOB-026, dinero) en vez de
// cerrar directo -- el resultado visible aquí es "pendiente de aprobación", nunca un
// cierre optimista fingido; la bandeja de /aprobaciones (badge del encabezado) es donde
// se completa.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wrench, Plus, DollarSign } from "lucide-react";
import { Badge, Button, Card, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, StatCard, formatMoney } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  ApiUnavailableError,
  cerrarTicketConCosto,
  crearTicketMantenimiento,
  listarTicketsMantenimiento,
  type TicketMantenimiento,
} from "../lib/api";

const REPORT_ROLES = ["owner", "gm", "frontdesk", "housekeeping", "maintenance"];
const ADMIN_ROLES = ["owner", "gm"];

const SEVERIDAD_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  alta: "destructive",
  media: "default",
  baja: "secondary",
};

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Mantenimiento() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [cerrando, setCerrando] = useState<TicketMantenimiento | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["mantenimiento-tickets", hotelActivoId],
    queryFn: () => listarTicketsMantenimiento(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const invalidar = () => queryClient.invalidateQueries({ queryKey: ["mantenimiento-tickets", hotelActivoId] });

  const crear = useMutation({
    mutationFn: (input: { roomCode?: string; title: string; description: string; severity: "alta" | "media" | "baja"; estimatedCost?: number }) =>
      crearTicketMantenimiento(hotelActivoId as string, input),
    onSuccess: (res) => {
      invalidar();
      setCreando(false);
      if (res.duplicate) setAviso("Ya existía un ticket abierto igual en las últimas 24h: no se duplicó.");
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const cerrarConCosto = useMutation({
    mutationFn: (input: { ticketId: string; actualCost: number; partUsed?: string }) =>
      cerrarTicketConCosto(hotelActivoId as string, input.ticketId, { actualCost: input.actualCost, partUsed: input.partUsed }),
    onSuccess: () => {
      invalidar();
      setCerrando(null);
      setAviso("Solicitud de autorización enviada — requiere confirmación de dos personas distintas en la bandeja de aprobaciones.");
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const puedeReportar = Boolean(sesion && REPORT_ROLES.includes(sesion.rol));
  const esAdmin = Boolean(sesion && ADMIN_ROLES.includes(sesion.rol));

  const abiertos = query.data?.filter((t) => t.estado !== "cerrado" && t.estado !== "cancelado").length;

  return (
    <div>
      <PageHeader
        titulo="Mantenimiento"
        descripcion="Tickets de mantenimiento correctivo: origen, severidad, costo estimado/real y autorización de gasto con doble confirmación."
        accion={
          puedeReportar ? (
            <Button onClick={() => setCreando(true)}>
              <Plus /> Reportar
            </Button>
          ) : undefined
        }
      />

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
        <StatCard icon={Wrench} label="Tickets abiertos" value={abiertos != null ? String(abiertos) : "—"} sinDato={abiertos == null ? "Sin datos todavía." : undefined} />
        <StatCard icon={DollarSign} label="Con aprobación pendiente" value={query.data ? String(query.data.filter((t) => t.aprobacionId && t.estado !== "cerrado").length) : "—"} sinDato={!query.data ? "Sin datos todavía." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay tickets de mantenimiento registrados."
        onReintentar={() => query.refetch()}
      >
        {(tickets: TicketMantenimiento[]) => (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {tickets.map((t) => (
              <Card key={t.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t.titulo}</span>
                    <Badge variant={SEVERIDAD_VARIANT[t.severidad]}>{t.severidad}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{t.descripcion}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.roomCode ? `Habitación ${t.roomCode} · ` : ""}Origen: {t.origen} · Estado: {t.estado}
                  </p>
                  <p className="text-sm">
                    {/* auditoria-2/frontend [ALTO]: un ticket sin costo estimado
                        capturado (el formulario de "Reportar" es opcional) muestra
                        "Sin estimar" -- nunca "$0.00", que se leería como una medición
                        real (REQ-UX-002). */}
                    Estimado: {t.costoEstimado != null ? `$${formatMoney(t.costoEstimado)} MXN` : "Sin estimar"}
                    {t.costoReal != null && <> · Real: ${formatMoney(t.costoReal)} MXN</>}
                  </p>
                  {esAdmin && t.estado !== "cerrado" && t.estado !== "cancelado" && !t.aprobacionId && (
                    <Button size="sm" variant="outline" onClick={() => setCerrando(t)}>
                      Cerrar con costo
                    </Button>
                  )}
                  {t.aprobacionId && t.estado !== "cerrado" && (
                    <p className="text-xs text-amber-600">Esperando doble aprobación de gasto.</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </DataState>

      <Dialog open={creando} onOpenChange={setCreando}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reportar ticket de mantenimiento</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const roomCode = String(form.get("roomCode") ?? "").trim();
              const estimatedCostRaw = String(form.get("estimatedCost") ?? "").trim();
              const estimatedCost = estimatedCostRaw === "" ? undefined : Number(estimatedCostRaw);
              crear.mutate({
                roomCode: roomCode || undefined,
                title: String(form.get("title") ?? "").trim(),
                description: String(form.get("description") ?? "").trim(),
                severity: (form.get("severity") as "alta" | "media" | "baja") ?? "media",
                estimatedCost: estimatedCost != null && Number.isFinite(estimatedCost) ? estimatedCost : undefined,
              });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="mt-room">Habitación (opcional)</Label>
              <Input id="mt-room" name="roomCode" placeholder="204" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-title">Título</Label>
              <Input id="mt-title" name="title" required maxLength={150} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-description">Descripción</Label>
              <Input id="mt-description" name="description" required maxLength={500} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-severity">Severidad</Label>
              <select id="mt-severity" name="severity" defaultValue="media" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="alta">Alta</option>
                <option value="media">Media</option>
                <option value="baja">Baja</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-estimated-cost">Costo estimado en MXN (opcional)</Label>
              <Input id="mt-estimated-cost" name="estimatedCost" type="number" step="0.01" min="0" placeholder="Déjalo vacío si aún no lo sabes" />
            </div>
            <Button type="submit" className="w-full" disabled={crear.isPending}>
              Reportar
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={cerrando !== null} onOpenChange={(open) => !open && setCerrando(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cerrar "{cerrando?.titulo}" con costo</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!cerrando) return;
              const form = new FormData(e.currentTarget);
              const actualCost = Number(form.get("actualCost"));
              if (!Number.isFinite(actualCost) || actualCost <= 0) {
                setError("El costo real debe ser un número positivo.");
                return;
              }
              cerrarConCosto.mutate({ ticketId: cerrando.id, actualCost, partUsed: String(form.get("partUsed") ?? "").trim() || undefined });
            }}
          >
            <p className="text-xs text-muted-foreground">
              Esto NO cierra el ticket de inmediato: crea una solicitud de autorización que requiere la confirmación de
              dos personas distintas (propietario/gerencia) antes de aplicarse.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="mt-cost">Costo real (MXN)</Label>
              <Input id="mt-cost" name="actualCost" type="number" step="0.01" min="0.01" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mt-part">Refacción usada (opcional)</Label>
              <Input id="mt-part" name="partUsed" maxLength={200} />
            </div>
            <Button type="submit" className="w-full" disabled={cerrarConCosto.isPending}>
              Solicitar autorización
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
