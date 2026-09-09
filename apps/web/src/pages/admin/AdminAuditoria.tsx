// H12b · LAUNCH-007: "auditoría de accesos del superadmin" — cada llamada a
// admin_negocio()/admin_reintentar_outbox() queda registrada en
// platform_admin_audit_log (packages/db/migrations/0100). Esta página solo lee.
import { useQuery } from "@tanstack/react-query";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@atiende/ui";
import { PageHeader } from "../../components/PageHeader";
import { DataState } from "../../components/DataState";
import { listarAdminAuditoria, type AdminAuditLogEntry } from "../../lib/adminApi";

export function AdminAuditoria() {
  const query = useQuery({ queryKey: ["admin-auditoria"], queryFn: listarAdminAuditoria, retry: false });

  return (
    <div>
      <PageHeader titulo="Auditoría" descripcion="Cada acceso/acción del superadmin a través de esta consola, incluida la lectura de negocio() y el reintento de outbox." />

      <DataState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        esVacio={(d: AdminAuditLogEntry[]) => d.length === 0}
        mensajeVacio="Sin accesos registrados todavía."
        onReintentar={() => query.refetch()}
      >
        {(data: AdminAuditLogEntry[]) => (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Acción</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{new Date(entry.created_at).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "medium" })}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.actor_id}</TableCell>
                    <TableCell>{entry.action}</TableCell>
                    <TableCell className="font-mono text-xs">{JSON.stringify(entry.detail)}</TableCell>
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
