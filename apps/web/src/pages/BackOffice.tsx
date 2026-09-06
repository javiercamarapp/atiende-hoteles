import { useQuery } from "@tanstack/react-query";
import { Building2, ExternalLink } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarCobrosVariables, type LineaCobro } from "../lib/api";

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
      <PageHeader titulo="Back office" descripcion="Cobros variables del mes, cada uno con el reporte de ahorro/valor que lo sustenta." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Building2} label="Total facturado del mes" value={totalMes != null ? `$${totalMes.toFixed(2)}` : "—"} sinDato={totalMes == null ? "Pendiente de conexión con facturación." : undefined} />
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
                    <TableCell className="text-right tabular-nums">${l.monto.toFixed(2)}</TableCell>
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
