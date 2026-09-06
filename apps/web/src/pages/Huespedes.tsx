import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarHuespedes, type Huesped } from "../lib/api";

export function Huespedes() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["huespedes", hotelActivoId],
    queryFn: () => listarHuespedes(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  // auditoria-2/frontend [MEDIO]: `listarHuespedes` → GET /hoteles/:hotelId/huespedes
  // hace `select ... from public.guest g left join public.reservation r`
  // (apps/api/src/routes/huespedes.ts) -- tablas propias, sin CRM externo. Mismo texto
  // "Pendiente de credenciales del PMS/CRM" ya corregido en Resumen.tsx/Disponibilidad.tsx
  // por la misma razón: con la API caída el motivo real es "sin conexión con el API",
  // nunca una integración pendiente.
  const sinDatoStatCard = !hotelActivoId ? "Sin hotel seleccionado." : query.isError ? "Sin conexión con el API." : "Sin datos todavía.";

  return (
    <div>
      <PageHeader titulo="Huéspedes" descripcion="Ficha de huésped e historial de estancias, con buscador y alta manual." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard
          icon={Users}
          label="Huéspedes registrados"
          value={query.data?.length != null ? String(query.data.length) : "—"}
          sinDato={query.data?.length == null ? sinDatoStatCard : undefined}
        />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay huéspedes registrados todavía para este hotel."
        onReintentar={() => query.refetch()}
      >
        {(huespedes: Huesped[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Correo</TableHead>
                  <TableHead className="text-right">Estancias</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {huespedes.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-medium">{h.nombre}</TableCell>
                    <TableCell>{h.email ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.estancias}</TableCell>
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
