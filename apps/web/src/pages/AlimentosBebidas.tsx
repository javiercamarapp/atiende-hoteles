import { UtensilsCrossed } from "lucide-react";
import { EstadoVacio } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";

/**
 * auditoria-2/frontend [ALTO]: esta pantalla llamaba `GET /hoteles/:hotelId/alimentos-bebidas`,
 * una ruta que ningún archivo de `apps/api/src/routes/*.ts` registraba nunca (404
 * siempre) y mostraba "Pendiente de conexión con el POS" — atribución falsa: el 404 no
 * era un problema de credenciales de una integración pendiente, era que el módulo de
 * Alimentos y Bebidas (pedidos de restaurante/bar/servicio a cuarto) simplemente no se
 * construyó todavía en este backend. Confirmado por el propio night audit
 * (`apps/api/src/jobs/nightAudit.ts`), que reporta la conciliación de A&B como
 * `conciliacionAB: { estado: "sin_pos_configurado" }` — declarado pendiente, no
 * simulado. Mientras ese módulo no exista, esta pantalla no hace NINGUNA llamada
 * fantasma: muestra un estado vacío honesto.
 */
export function AlimentosBebidas() {
  return (
    <div>
      <PageHeader titulo="Alimentos y Bebidas" descripcion="Servicio a cuarto y consumo de restaurante/bar cargado a folio." />
      <EstadoVacio
        icon={UtensilsCrossed}
        titulo="Módulo no implementado todavía"
        mensaje="Alimentos y Bebidas (pedidos de restaurante/bar/servicio a cuarto, conciliación con el POS) no tiene backend construido en este repositorio todavía — no es un problema de credenciales ni de conexión, el módulo en sí no existe aún. El night audit ya lo declara honestamente como 'sin_pos_configurado' en vez de simular un consumo."
      />
    </div>
  );
}
