import { useQuery } from "@tanstack/react-query";
import { UtensilsCrossed } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarPedidosAB, type PedidoAB } from "../lib/api";

export function AlimentosBebidas() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["alimentos-bebidas", hotelActivoId],
    queryFn: () => listarPedidosAB(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const totalDia = query.data?.reduce((acc, p) => acc + p.total, 0);

  return (
    <div>
      <PageHeader titulo="Alimentos y Bebidas" descripcion="Servicio a cuarto y consumo de restaurante/bar cargado a folio." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={UtensilsCrossed} label="Pedidos abiertos" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "Pendiente de conexión con el POS." : undefined} />
        <StatCard icon={UtensilsCrossed} label="Consumo del día" value={totalDia != null ? `$${totalDia.toFixed(2)}` : "—"} sinDato={totalDia == null ? "Pendiente de conexión con el POS." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay pedidos de alimentos y bebidas abiertos."
        onReintentar={() => query.refetch()}
      >
        {(pedidos: PedidoAB[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Habitación/Mesa</TableHead>
                  <TableHead>Artículos</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pedidos.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.habitacionOMesa}</TableCell>
                    <TableCell>{p.items}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{p.estado}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">${p.total.toFixed(2)}</TableCell>
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
