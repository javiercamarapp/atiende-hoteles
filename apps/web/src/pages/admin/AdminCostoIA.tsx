// H12b · LAUNCH-007: agentes y gates por hotel, costo del mes vs. techo configurado
// (mismos datos que `agent_cost_mes()`/`agent_config` por hotel, agregados cross-tenant
// por `admin_negocio()` en vez de recorrer hotel por hotel).
import { useQuery } from "@tanstack/react-query";
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../../components/PageHeader";
import { DataState } from "../../components/DataState";
import { obtenerAdminNegocio, type AdminAgenteResumen, type AdminNegocio } from "../../lib/adminApi";

const GATE_LABEL: Record<AdminAgenteResumen["gate"], string> = {
  shadow: "Shadow (sin acción real)",
  propone: "Propone (requiere aprobación)",
  autopilot: "Autopilot",
};

export function AdminCostoIA() {
  const query = useQuery({ queryKey: ["admin-negocio"], queryFn: obtenerAdminNegocio, retry: false });

  return (
    <div>
      <PageHeader titulo="Costo de IA" descripcion="Agentes configurados por hotel: gate, techo mensual y consumo real del mes en curso." />

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        esVacio={(d: AdminNegocio) => d.agentes.length === 0}
        mensajeVacio="Ningún hotel tiene agentes configurados todavía."
        onReintentar={() => query.refetch()}
      >
        {(data: AdminNegocio) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hotel</TableHead>
                  <TableHead>Agente</TableHead>
                  <TableHead>Gate</TableHead>
                  <TableHead>Consumido (mes)</TableHead>
                  <TableHead>Techo (mes)</TableHead>
                  <TableHead>% usado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agentes.map((a) => {
                  const pct = a.monthly_ceiling_usd > 0 ? Math.round((a.costo_mes_usd / a.monthly_ceiling_usd) * 100) : 0;
                  return (
                    <TableRow key={`${a.hotel_id}-${a.agent_name}`}>
                      <TableCell className="font-medium">{a.hotel_nombre}</TableCell>
                      <TableCell>{a.agent_name}</TableCell>
                      <TableCell>
                        <Badge variant={a.gate === "autopilot" ? "default" : "secondary"}>{GATE_LABEL[a.gate]}</Badge>
                      </TableCell>
                      <TableCell>${a.costo_mes_usd.toFixed(2)} USD</TableCell>
                      <TableCell>${a.monthly_ceiling_usd.toFixed(2)} USD</TableCell>
                      <TableCell>
                        <span className={pct >= 100 ? "text-destructive font-medium" : pct >= 80 ? "text-amber-600 font-medium" : ""}>{pct}%</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DataState>
    </div>
  );
}
