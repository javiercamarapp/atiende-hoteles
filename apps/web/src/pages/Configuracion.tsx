import { useQuery } from "@tanstack/react-query";
import { Users2 } from "lucide-react";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, ThemeSelector, Card, CardHeader, CardTitle, CardContent } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";
import { DataState } from "../components/DataState";
import { useHotel } from "../hooks/useHotel";
import { listarStaff, type StaffCuenta } from "../lib/api";

export function Configuracion() {
  const { hotelActivoId } = useHotel();
  const query = useQuery({
    queryKey: ["configuracion-staff", hotelActivoId],
    queryFn: () => listarStaff(hotelActivoId as string),
    enabled: Boolean(hotelActivoId),
    retry: false,
  });

  return (
    <div>
      <PageHeader titulo="Configuración" descripcion="Cuentas de personal, roles (owner, gm, frontdesk, reservations, housekeeping, maintenance, fnb, accountant) y preferencias." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Apariencia</CardTitle>
        </CardHeader>
        <CardContent>
          <ThemeSelector />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <StatCard icon={Users2} label="Cuentas de personal" value={query.data?.length != null ? String(query.data.length) : "—"} sinDato={query.data?.length == null ? "Pendiente de conexión con el backend." : undefined} />
      </div>

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        mensajeVacio="No hay cuentas de personal dadas de alta todavía."
        onReintentar={() => query.refetch()}
      >
        {(staff: StaffCuenta[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Correo</TableHead>
                  <TableHead>Rol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.email}</TableCell>
                    <TableCell className="capitalize">{s.rol}</TableCell>
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
