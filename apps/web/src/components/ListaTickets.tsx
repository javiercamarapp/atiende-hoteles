import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "./PageHeader";
import { DataState } from "./DataState";
import { useHotel } from "../hooks/useHotel";
import { listarTickets, type TicketOperativo } from "../lib/api";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

const colorPrioridad: Record<TicketOperativo["prioridad"], "default" | "destructive" | "secondary"> = {
  alta: "destructive",
  media: "default",
  baja: "secondary",
};

/**
 * Vista compartida por Housekeeping y Mantenimiento — misma anatomía de
 * tabla con StatCard de conteo por prioridad, evitando duplicar el patrón
 * "nunca inventar una cifra" en cada pantalla operativa.
 */
export function ListaTickets({
  area,
  titulo,
  descripcion,
  icono: Icono,
}: {
  area: "housekeeping" | "mantenimiento";
  titulo: string;
  descripcion: string;
  icono: IconType;
}) {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["tickets", area, hotelActivoId],
    queryFn: () => listarTickets(hotelActivoId as string, area),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const altas = query.data?.filter((t) => t.prioridad === "alta").length;

  return (
    <div>
      <PageHeader titulo={titulo} descripcion={descripcion} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Icono} label="Tickets abiertos" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "Pendiente de conexión con el sistema operativo del hotel." : undefined} />
        <StatCard icon={Icono} label="Prioridad alta" value={altas != null ? String(altas) : "—"} sinDato={altas == null ? "Pendiente de conexión con el sistema operativo del hotel." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio={`No hay tickets de ${titulo.toLowerCase()} abiertos.`}
        onReintentar={() => query.refetch()}
      >
        {(tickets: TicketOperativo[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Título</TableHead>
                  <TableHead>Prioridad</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.titulo}</TableCell>
                    <TableCell>
                      <Badge variant={colorPrioridad[t.prioridad]}>{t.prioridad}</Badge>
                    </TableCell>
                    <TableCell>{t.estado}</TableCell>
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
