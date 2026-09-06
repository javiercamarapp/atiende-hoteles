// H6b · Bandeja de aprobaciones (ADR-006/GOB-026): lista solicitudes reales de
// `agent_approval` por hotel; decidir (aprobar/rechazar) exige un motivo textual exacto
// (auditable) y está reservado a owner/gm tanto en la API/RLS como aquí. Las de dinero
// muestran cuántas confirmaciones llevan de las que requieren (doble confirmación de dos
// roles distintos).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Check, X } from "lucide-react";
import { Badge, Button, Card, CardContent, StatCard } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import { ApiUnavailableError, decidirAprobacion, listarAprobaciones, type SolicitudAprobacion } from "../lib/api";

const ADMIN_ROLES = ["owner", "gm"];

const ESTADO_VARIANT: Record<SolicitudAprobacion["estado"], "default" | "secondary" | "destructive"> = {
  pendiente: "default",
  aprobada: "secondary",
  rechazada: "destructive",
  expirada: "destructive",
};

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

export function Aprobaciones() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["aprobaciones", hotelActivoId],
    queryFn: () => listarAprobaciones(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const decidir = useMutation({
    mutationFn: (input: { id: string; decision: "aprobar" | "rechazar" }) => {
      const texto = window.prompt(
        input.decision === "aprobar" ? "Motivo de la autorización (queda registrado):" : "Motivo del rechazo (queda registrado):",
      );
      if (!texto || !texto.trim()) throw new Error("Se requiere un motivo para decidir esta solicitud.");
      return decidirAprobacion(hotelActivoId as string, input.id, { decision: input.decision, textoExacto: texto.trim() });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["aprobaciones", hotelActivoId] }),
    onError: (err) => setError(mensajeError(err)),
  });

  const esAdmin = Boolean(sesion && ADMIN_ROLES.includes(sesion.rol));
  const pendientes = query.data?.filter((a) => a.estado === "pendiente").length;

  return (
    <div>
      <PageHeader titulo="Aprobaciones" descripcion="Bandeja de acciones de agente que requieren autorización humana (dinero o efectos externos, GOB-026)." />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!esAdmin && (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Tu rol ({sesion?.rol ?? "sin sesión"}) puede ver esta bandeja pero solo propietario/gerencia puede decidir.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={ShieldCheck} label="Pendientes" value={pendientes != null ? String(pendientes) : "—"} sinDato={pendientes == null ? "Sin datos todavía." : undefined} />
      </div>

      <DataState isLoading={query.isLoading} error={query.error} data={query.data} mensajeVacio="No hay solicitudes de aprobación." onReintentar={() => query.refetch()}>
        {(solicitudes: SolicitudAprobacion[]) => (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {solicitudes.map((s) => (
              <Card key={s.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{s.tool}</span>
                    <Badge variant={ESTADO_VARIANT[s.estado]}>{s.estado}</Badge>
                  </div>
                  <p className="text-sm">{s.textoMostrado}</p>
                  <p className="text-xs text-muted-foreground">
                    Solicitado por {s.solicitadoPor}
                    {s.esDinero ? ` · dinero (requiere ${s.confirmacionesRequeridas} confirmaciones de roles distintos)` : ""}
                  </p>
                  {esAdmin && s.estado === "pendiente" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => decidir.mutate({ id: s.id, decision: "aprobar" })} disabled={decidir.isPending}>
                        <Check /> Aprobar
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => decidir.mutate({ id: s.id, decision: "rechazar" })} disabled={decidir.isPending}>
                        <X /> Rechazar
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
