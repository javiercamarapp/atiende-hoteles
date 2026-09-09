import { Star } from "lucide-react";
import { EstadoVacio } from "@atiende/ui";
import { PageHeader } from "../components/PageHeader";

/**
 * REQ-UX-002 (auditoría propia, mismo patrón ya aplicado en AlimentosBebidas.tsx):
 * esta pantalla llamaba `GET /hoteles/:hotelId/reputacion` (`listarResenas` en
 * `lib/api.ts`), una ruta que ningún archivo de `apps/api/src/routes/*.ts` registra
 * (confirmado: no existe `reputacionRoutes` ni ningún registro de esa ruta en
 * `apps/api/src/app.ts`, ni tabla de reseñas en `packages/db/migrations/*.sql`) —
 * 404 siempre — y mostraba "Integración con Google/Booking/TripAdvisor pendiente."
 * en el StatCard: atribución falsa idéntica a la que ya se corrigió en
 * AlimentosBebidas.tsx. El 404 no es un bloqueo de credenciales de una integración
 * ya conectada a medias: el índice de reputación (REQ-CRM-006, panel tipo GRI) es
 * un módulo que todavía no se construyó en este backend. Mientras no exista, esta
 * pantalla no hace NINGUNA llamada fantasma: muestra un estado vacío honesto en vez
 * de simular "pendiente de credenciales" para un módulo que ni siquiera tiene
 * endpoint.
 */
export function Reputacion() {
  return (
    <div>
      <PageHeader titulo="Reputación" descripcion="Reseñas de Google, Booking y TripAdvisor centralizadas, con estado de respuesta." />
      <EstadoVacio
        icon={Star}
        titulo="Módulo no implementado todavía"
        mensaje="El índice de reputación (REQ-CRM-006: reseñas de Google/Booking/TripAdvisor, tasa de respuesta, efecto estimado en ADR) no tiene backend construido en este repositorio todavía — no es un problema de credenciales de una integración ya conectada, el módulo en sí no existe aún."
      />
    </div>
  );
}
