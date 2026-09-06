// H7 · Sección "Agentes" (ADR-006): gate (shadow/propone/autopilot) y techo mensual por
// agente, costo del mes con barra de progreso (o "sin datos" honesto), y una demo
// determinista con FakeProvider (recorrido de check-in con incidencia, etiquetada
// "simulado") que muestra qué HARÍA el agente -- aud-2 agentico CRÍTICO: la demo
// SIEMPRE corre en gate "shadow" forzado en el servidor (nunca el gate real
// configurado, sin importar en qué gate esté el agente), así que ningún efecto real se
// ejecuta sobre datos operativos del hotel; el panel muestra el gate EFECTIVO que
// devuelve la API, no el gate configurado, para no sugerir que la demo corrió con el
// gate de producción. Owner/gm pueden cambiar gate/techo; el resto del staff solo ve
// el tablero.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Play, ShieldAlert } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { useAuth } from "../hooks/useAuth";
import {
  ApiUnavailableError,
  actualizarConfigAgente,
  ejecutarAgente,
  listarAgentes,
  listarCostosAgentes,
  type AgentGate,
  type AgenteCatalogo,
  type AgenteCosto,
  type AgenteEjecucionResultado,
} from "../lib/api";

const ADMIN_ROLES = ["owner", "gm"];
const GATES: AgentGate[] = ["shadow", "propone", "autopilot"];

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

function BarraCosto({ pct, alerta }: { pct: number; alerta: boolean }) {
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={`h-full rounded-full ${alerta ? "bg-destructive" : "bg-primary"}`}
        style={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
      />
    </div>
  );
}

export function Agentes() {
  const { hotelActivoId } = useHotel();
  const { sesion } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Record<string, AgenteEjecucionResultado>>({});

  const esAdmin = Boolean(sesion && ADMIN_ROLES.includes(sesion.rol));

  const catalogo = useQuery({
    queryKey: ["agentes-catalogo", hotelActivoId],
    queryFn: () => listarAgentes(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const costos = useQuery({
    queryKey: ["agentes-costos", hotelActivoId],
    queryFn: () => listarCostosAgentes(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const costoPorAgente = new Map((costos.data ?? []).map((c) => [c.agente, c]));

  const cambiarConfig = useMutation({
    mutationFn: (input: { agente: string; gate?: AgentGate; techoMensualUsd?: number }) =>
      actualizarConfigAgente(hotelActivoId as string, input.agente, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agentes-catalogo", hotelActivoId] });
      queryClient.invalidateQueries({ queryKey: ["agentes-costos", hotelActivoId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const correrDemo = useMutation({
    mutationFn: (agente: string) =>
      ejecutarAgente(hotelActivoId as string, agente, {
        mensaje: "Huésped reporta aire acondicionado descompuesto al hacer check-in.",
        demo: true,
      }),
    onSuccess: (data, agente) => {
      setResultados((prev) => ({ ...prev, [agente]: data }));
      queryClient.invalidateQueries({ queryKey: ["agentes-costos", hotelActivoId] });
    },
    onError: (err) => setError(mensajeError(err)),
  });

  return (
    <div>
      <PageHeader
        titulo="Agentes"
        descripcion="Gate (shadow → propone → autopilot), techo de costo mensual por agente y una demo determinista de qué haría cada agente."
      />

      <p className="mb-4 text-xs text-muted-foreground">
        El valor de ROI mostrado en Resumen usa los supuestos de{" "}
        <code className="rounded bg-muted px-1 py-0.5">H17-v1</code> (docs/referencia/03-investigacion-H12-H21.md, sección H17):
        método contrafactual y nivel de confianza explícitos por evento, sin línea base firmada todavía (REQ-REV-018) -- por eso
        siempre se etiqueta "estimado", nunca un cobro por resultado.
      </p>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!esAdmin && (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Tu rol ({sesion?.rol ?? "sin sesión"}) puede ver esta pantalla, pero solo propietario/gerencia puede cambiar el gate o el techo de costo.
        </div>
      )}

      <DataState isLoading={catalogo.isLoading} error={catalogo.error} data={catalogo.data} mensajeVacio="No hay agentes en el catálogo." onReintentar={() => catalogo.refetch()}>
        {(agentes: AgenteCatalogo[]) => (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {agentes.map((a) => {
              const costo = costoPorAgente.get(a.agente);
              const resultado = resultados[a.agente];
              return (
                <Card key={a.agente}>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="size-4" aria-hidden="true" /> {a.etiqueta}
                      <Badge variant={a.gate === "autopilot" ? "default" : "secondary"}>{a.gate}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">{a.descripcion}</p>
                    <p className="text-xs text-muted-foreground">
                      Modelo: {a.rolModelo} · Roles permitidos: {a.rolesPermitidos.join(", ")}
                    </p>

                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span>Costo del mes</span>
                        {costo ? (
                          <span className={costo.alerta ? "text-destructive font-medium" : "text-muted-foreground"}>
                            ${costo.consumidoUsd.toFixed(2)} / ${costo.techoMensualUsd.toFixed(2)} {costo.moneda}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Sin datos todavía.</span>
                        )}
                      </div>
                      {costo && !costo.sinDatos ? (
                        <BarraCosto pct={costo.pctUsado} alerta={costo.alerta} />
                      ) : (
                        <p className="text-xs text-muted-foreground">Sin corridas registradas este mes todavía.</p>
                      )}
                      {costo?.alerta && (
                        <p className="mt-1 text-xs text-destructive flex items-center gap-1">
                          <ShieldAlert className="size-3" aria-hidden="true" /> Al {Math.round(costo.umbralAlertaPct * 100)}% o más del techo mensual.
                        </p>
                      )}
                    </div>

                    {esAdmin && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                        <Label htmlFor={`gate-${a.agente}`} className="text-xs">
                          Gate
                        </Label>
                        <select
                          id={`gate-${a.agente}`}
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                          value={a.gate}
                          onChange={(e) => cambiarConfig.mutate({ agente: a.agente, gate: e.target.value as AgentGate })}
                          disabled={cambiarConfig.isPending}
                        >
                          {GATES.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                        <Label htmlFor={`techo-${a.agente}`} className="text-xs">
                          Techo USD/mes
                        </Label>
                        <Input
                          id={`techo-${a.agente}`}
                          type="number"
                          min={0}
                          step="0.01"
                          defaultValue={a.techoMensualUsd}
                          className="h-8 w-24 text-xs"
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value) && value !== a.techoMensualUsd) {
                              cambiarConfig.mutate({ agente: a.agente, techoMensualUsd: value });
                            }
                          }}
                        />
                      </div>
                    )}

                    <div className="pt-2 border-t border-border">
                      <Button size="sm" variant="outline" onClick={() => correrDemo.mutate(a.agente)} disabled={correrDemo.isPending}>
                        <Play className="size-3.5" /> Demo (simulada)
                      </Button>
                      {resultado && (
                        <div className="mt-2 rounded-md border border-border bg-muted/50 p-2 text-xs space-y-1">
                          <p>
                            <span className="font-medium">Resultado:</span> {resultado.estado}{" "}
                            {resultado.simulado && <Badge variant="secondary">simulado</Badge>}{" "}
                            {resultado.simulado && (
                              <Badge variant="outline" title="Una demo siempre corre en gate 'shadow', sin ejecutar ningún efecto real, sin importar el gate configurado del agente.">
                                gate real de la demo: {resultado.gate}
                              </Badge>
                            )}
                          </p>
                          <p className="text-muted-foreground">{resultado.mensaje}</p>
                          {resultado.costoUsd != null && (
                            <p className="text-muted-foreground">
                              Costo de esta corrida: ${resultado.costoUsd.toFixed(4)} USD · {resultado.pasos} paso(s)
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DataState>
    </div>
  );
}
