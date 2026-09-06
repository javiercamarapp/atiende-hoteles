import { useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarConversaciones, type ConversacionMensaje } from "../lib/api";

export function Mensajeria() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["mensajeria", hotelActivoId],
    queryFn: () => listarConversaciones(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  const pendientesAprobacion = query.data?.filter((c) => c.requiereAprobacion).length;

  return (
    <div>
      <PageHeader titulo="Mensajería" descripcion="Conversaciones de WhatsApp y voz con huéspedes, agentes conversacionales por hotel." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={MessageCircle} label="Conversaciones activas" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "WhatsApp Cloud API: pendiente de credenciales." : undefined} />
        <StatCard icon={MessageCircle} label="Requieren aprobación" value={pendientesAprobacion != null ? String(pendientesAprobacion) : "—"} sinDato={pendientesAprobacion == null ? "WhatsApp Cloud API: pendiente de credenciales." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay conversaciones activas."
        onReintentar={() => query.refetch()}
      >
        {(conversaciones: ConversacionMensaje[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Huésped</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Último mensaje</TableHead>
                  <TableHead>Hace</TableHead>
                  <TableHead>Aprobación</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversaciones.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.huesped}</TableCell>
                    <TableCell className="capitalize">{c.canal}</TableCell>
                    <TableCell className="max-w-xs truncate">{c.ultimoMensaje}</TableCell>
                    <TableCell>{c.hace}</TableCell>
                    <TableCell>{c.requiereAprobacion ? <Badge variant="destructive">Pendiente</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
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
