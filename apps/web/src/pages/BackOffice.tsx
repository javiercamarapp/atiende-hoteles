import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, ExternalLink, Moon, FileCheck2 } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Card, CardHeader, CardTitle, CardContent, Button, Badge, formatMoney } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import {
  listarCobrosVariables,
  ejecutarNightAudit,
  listarNightAuditHistorial,
  listarCfdiDelHotel,
  ApiUnavailableError,
  type LineaCobro,
  type NightAuditSummary,
} from "../lib/api";

function mensajeError(err: unknown): string {
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return "Ocurrió un error inesperado.";
}

/**
 * Back office — cada línea de cobro variable enlaza a su `roi_event`
 * (REQ-UX-004: "la factura nunca llega sin su justificación"). Si el
 * backend devuelve una línea sin `roiEventUrl`, se declara explícitamente
 * en vez de mostrar un enlace roto.
 */
export function BackOffice() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["back-office-cobros", hotelActivoId],
    queryFn: () => listarCobrosVariables(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const totalMes = query.data?.reduce((acc, l) => acc + l.monto, 0);

  return (
    <div>
      <PageHeader titulo="Back office" descripcion="Cierre diario, CFDI emitidos y cobros variables del mes, cada uno con su justificación." />

      {hotelActivoId && <SeccionCierreDiario hotelId={hotelActivoId} />}
      {hotelActivoId && <SeccionCfdiEmitidos hotelId={hotelActivoId} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Building2} label="Total facturado del mes" value={totalMes != null ? `$${formatMoney(totalMes)}` : "—"} sinDato={totalMes == null ? "Pendiente de conexión con facturación." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay líneas de cobro variable este mes."
        onReintentar={() => query.refetch()}
      >
        {(lineas: LineaCobro[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Concepto</TableHead>
                  <TableHead className="text-right">Monto</TableHead>
                  <TableHead>Justificación</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineas.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.concepto}</TableCell>
                    <TableCell className="text-right tabular-nums">${formatMoney(l.monto)}</TableCell>
                    <TableCell>
                      {l.roiEventUrl ? (
                        <a href={l.roiEventUrl} className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
                          Ver reporte de ahorro/valor <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-destructive text-sm">Sin justificación registrada — no debería facturarse así</span>
                      )}
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

/** H5 · REQ-REV-013/H16-003: dispara/consulta el night audit del día -- postea
 *  hospedaje, marca no-shows, congela el día y muestra el resumen de caja. Correrlo
 *  dos veces para el mismo día es seguro (devuelve el resumen ya guardado). */
function SeccionCierreDiario({ hotelId }: { hotelId: string }) {
  const [error, setError] = useState<string | null>(null);
  const historial = useQuery({
    queryKey: ["night-audit-historial", hotelId],
    queryFn: () => listarNightAuditHistorial(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  const mutacion = useMutation({
    mutationFn: () => ejecutarNightAudit(hotelId),
    onSuccess: () => {
      setError(null);
      void historial.refetch();
    },
    onError: (err) => setError(mensajeError(err)),
  });

  const resumen = mutacion.data as NightAuditSummary | undefined;

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Moon className="size-4" aria-hidden="true" /> Cierre diario (night audit)
        </CardTitle>
        <Button size="sm" onClick={() => mutacion.mutate()} disabled={mutacion.isPending}>
          {mutacion.isPending ? "Cerrando..." : "Correr cierre de hoy"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {resumen && (
          <div className="text-sm space-y-1" role="status">
            <p>
              {resumen.yaCompletado ? "Ya se había cerrado este día — mismo resumen." : "Cierre ejecutado."} Cargos
              posteados: {resumen.postedCharges.length}. No-shows marcados: {resumen.noShows.length}. En casa:{" "}
              {resumen.ocupacion.enCasa}.
            </p>
            <p className="text-muted-foreground">
              Conciliación A&B/spa contra POS:{" "}
              {resumen.conciliacionAB.estado === "sin_pos_configurado" ? "sin POS configurado todavía" : resumen.conciliacionAB.estado}
            </p>
          </div>
        )}
        <DataState
          isLoading={historial.isLoading}
          error={historial.error}
          data={historial.data}
          mensajeVacio="Todavía no se ha corrido ningún cierre diario para este hotel."
          onReintentar={() => historial.refetch()}
        >
          {(filas) => (
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filas.map((f) => (
                    <TableRow key={f.fecha}>
                      <TableCell>{f.fecha}</TableCell>
                      <TableCell>
                        <Badge variant={f.estado === "completado" ? "default" : "secondary"}>{f.estado}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

/** H5 · REQ-BO-001/002: CFDI emitidos del hotel con su estado real (timbrado/
 *  cancelado) o "pendiente de PAC" si el timbrado aún no resolvió -- nunca se
 *  muestra un estado inventado. */
function SeccionCfdiEmitidos({ hotelId }: { hotelId: string }) {
  const query = useQuery({
    queryKey: ["cfdi-hotel", hotelId],
    queryFn: () => listarCfdiDelHotel(hotelId),
    enabled: Boolean(hotelId),
    retry: false,
  });

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileCheck2 className="size-4" aria-hidden="true" /> CFDI emitidos
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DataState
          isLoading={query.isLoading}
          error={query.error}
          data={query.data}
          mensajeVacio="No hay CFDI emitidos todavía."
          onReintentar={() => query.refetch()}
        >
          {(cfdis) => (
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>UUID</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cfdis.map((cfdi) => (
                    <TableRow key={cfdi.id}>
                      <TableCell className="font-mono text-xs">{cfdi.uuidFiscal ?? "pendiente de PAC"}</TableCell>
                      <TableCell className="capitalize">{cfdi.tipo}</TableCell>
                      <TableCell>
                        <Badge variant={cfdi.estado === "timbrado" ? "default" : cfdi.estado === "cancelado" ? "outline" : "secondary"}>
                          {cfdi.estado}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">${formatMoney(cfdi.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
