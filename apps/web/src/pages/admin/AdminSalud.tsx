// H12b · LAUNCH-007: salud (health/ready del proceso API) + outbox pendientes/dead-letter
// y aprobaciones vencidas POR HOTEL, con la única acción de escritura permitida desde
// /admin (reintentar un evento outbox en dead-letter) — explícita y auditada, nunca un
// cambio a datos de negocio.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Badge, Button, StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../../components/PageHeader";
import { DataState } from "../../components/DataState";
import { ApiUnavailableError, obtenerAdminNegocio, obtenerSaludApi, reintentarOutbox, type AdminNegocio } from "../../lib/adminApi";

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function AdminSalud() {
  const [outboxIdManual, setOutboxIdManual] = useState("");
  const queryClient = useQueryClient();

  const salud = useQuery({ queryKey: ["admin-salud-api"], queryFn: obtenerSaludApi, retry: false, refetchInterval: 30_000 });
  const negocio = useQuery({ queryKey: ["admin-negocio"], queryFn: obtenerAdminNegocio, retry: false });

  return (
    <div>
      <PageHeader
        titulo="Salud"
        descripcion="Health/ready del proceso, outbox pendiente/dead-letter y aprobaciones vencidas por hotel. Reintentar un evento es la única escritura permitida desde esta consola."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
          {salud.data?.health?.status === "ok" ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          ) : (
            <XCircle className="w-5 h-5 text-destructive" />
          )}
          <div>
            <p className="text-sm font-medium">/health</p>
            <p className="text-xs text-muted-foreground">{salud.data?.health?.status ?? (salud.isLoading ? "consultando…" : "sin respuesta")}</p>
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
          {salud.data?.ready?.status === "ok" ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          ) : (
            <XCircle className="w-5 h-5 text-destructive" />
          )}
          <div>
            <p className="text-sm font-medium">/ready</p>
            <p className="text-xs text-muted-foreground">
              {salud.data?.ready?.status === "ok"
                ? `${salud.data.ready.migrationsApplied} migraciones aplicadas`
                : (salud.data?.ready?.reason ?? (salud.isLoading ? "consultando…" : "sin respuesta"))}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => salud.refetch()} className="self-center justify-self-start">
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualizar
        </Button>
      </div>

      <DataState isLoading={negocio.isLoading} error={negocio.error} data={negocio.data} mensajeVacio="Sin hoteles registrados." onReintentar={() => negocio.refetch()}>
        {(data: AdminNegocio) => (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              <StatCard icon={XCircle} label="Outbox en dead-letter (global)" value={String(data.metricasGlobales.outboxDeadLetterTotal)} />
              <StatCard icon={CheckCircle2} label="Aprobaciones vencidas (global)" value={String(data.metricasGlobales.aprobacionesVencidasTotal)} />
            </div>

            <div className="rounded-xl border border-border overflow-hidden mb-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hotel</TableHead>
                    <TableHead>Outbox pendientes</TableHead>
                    <TableHead>Outbox dead-letter</TableHead>
                    <TableHead>Aprobaciones vencidas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.hoteles.map((h) => (
                    <TableRow key={h.hotel_id}>
                      <TableCell className="font-medium">{h.nombre}</TableCell>
                      <TableCell>{h.outbox_pendientes}</TableCell>
                      <TableCell>
                        {h.outbox_dead_letter > 0 ? <Badge variant="destructive">{h.outbox_dead_letter}</Badge> : h.outbox_dead_letter}
                      </TableCell>
                      <TableCell>
                        {h.aprobaciones_vencidas > 0 ? <Badge variant="destructive">{h.aprobaciones_vencidas}</Badge> : h.aprobaciones_vencidas}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DataState>

      <ReintentarOutbox
        outboxIdManual={outboxIdManual}
        setOutboxIdManual={setOutboxIdManual}
        onExito={() => queryClient.invalidateQueries({ queryKey: ["admin-negocio"] })}
      />
    </div>
  );
}

function ReintentarOutbox({
  outboxIdManual,
  setOutboxIdManual,
  onExito,
}: {
  outboxIdManual: string;
  setOutboxIdManual: (v: string) => void;
  onExito: () => void;
}) {
  const [mensaje, setMensaje] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (outboxId: string) => reintentarOutbox(outboxId),
    onSuccess: () => {
      setMensaje("Evento reintentado (auditado en la pestaña Auditoría).");
      onExito();
    },
    onError: (err) => setMensaje(mensajeError(err)),
  });

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h2 className="font-medium mb-1">Reintentar un evento outbox en dead-letter</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Única escritura operativa permitida desde esta consola (LAUNCH-007): reactiva el evento (status → pendiente), nunca modifica reservas, folios ni cargos.
      </p>
      <div className="flex gap-2">
        <input
          value={outboxIdManual}
          onChange={(e) => setOutboxIdManual(e.target.value)}
          placeholder="ID del evento outbox (uuid)"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <Button
          size="sm"
          disabled={!outboxIdManual || mutation.isPending}
          onClick={() => mutation.mutate(outboxIdManual)}
        >
          Reintentar
        </Button>
      </div>
      {mensaje && <p className="text-sm mt-2 text-muted-foreground">{mensaje}</p>}
    </div>
  );
}
