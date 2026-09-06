// H12b · LAUNCH-007: tenants/hoteles (estado, última actividad) + métricas globales
// agregadas sin PII, leídas de UNA sola llamada a `GET /admin/negocio` (que en el
// servidor llama a la única función `admin_negocio()` autorizada a cruzar tenants).
import { Building2, CalendarClock, DollarSign, Percent, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { StatCard, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../../components/PageHeader";
import { DataState } from "../../components/DataState";
import { obtenerAdminNegocio, type AdminNegocio as AdminNegocioDto } from "../../lib/adminApi";

function formatoMoneda(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
}

function formatoFecha(iso: string | null): string {
  if (!iso) return "Sin actividad";
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function AdminNegocio() {
  const query = useQuery({
    queryKey: ["admin-negocio"],
    queryFn: obtenerAdminNegocio,
    retry: false,
  });

  return (
    <div>
      <PageHeader
        titulo="Negocio"
        descripcion="Tenants/hoteles, última actividad y métricas globales agregadas — sin datos personales de huéspedes."
      />

      <DataState isLoading={query.isLoading} error={query.error} data={query.data} mensajeVacio="Sin hoteles registrados." onReintentar={() => query.refetch()}>
        {(data: AdminNegocioDto) => (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
              <StatCard icon={Building2} label="Hoteles" value={String(data.metricasGlobales.hotelesTotal)} />
              <StatCard icon={Users} label="Reservas confirmadas" value={String(data.metricasGlobales.reservasConfirmadasTotal)} nota={`de ${data.metricasGlobales.reservasTotal} totales`} />
              <StatCard
                icon={Percent}
                label="Ocupación media"
                value={data.metricasGlobales.ocupacionMediaHabitaciones != null ? `${data.metricasGlobales.ocupacionMediaHabitaciones}%` : "—"}
                sinDato={data.metricasGlobales.ocupacionMediaHabitaciones == null ? "Sin reservas registradas todavía." : undefined}
              />
              <StatCard icon={DollarSign} label="Ingresos agregados" value={formatoMoneda(data.metricasGlobales.ingresosTotales)} nota="Todos los hoteles, sin PII" />
              <StatCard
                icon={CalendarClock}
                label="Costo de IA (mes)"
                value={`$${data.metricasGlobales.costoIaMesUsdTotal.toFixed(2)} USD`}
                nota={`Techo: $${data.metricasGlobales.techoIaMesUsdTotal.toFixed(2)} USD`}
              />
            </div>

            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hotel</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Staff</TableHead>
                    <TableHead>Última actividad</TableHead>
                    <TableHead>Reservas</TableHead>
                    <TableHead>Ingresos</TableHead>
                    <TableHead>Costo IA / techo (mes)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.hoteles.map((h) => (
                    <TableRow key={h.hotel_id}>
                      <TableCell className="font-medium">{h.nombre}</TableCell>
                      <TableCell>{h.org_nombre}</TableCell>
                      <TableCell>{h.staff_count}</TableCell>
                      <TableCell>{formatoFecha(h.ultima_actividad_at)}</TableCell>
                      <TableCell>
                        {h.reservas_confirmadas} / {h.reservas_total}
                      </TableCell>
                      <TableCell>{formatoMoneda(h.ingresos_totales)}</TableCell>
                      <TableCell>
                        ${h.costo_ia_mes_usd.toFixed(2)} / ${h.techo_ia_mes_usd.toFixed(2)} USD
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
