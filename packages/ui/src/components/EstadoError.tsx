import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";

/**
 * Portado de EstadoError (kit.tsx) — docs/referencia/06-backoffice-agentes-likida.md
 * §3.5: tarjeta con botón "Reintentar" para un fallo de lectura explícito,
 * nunca una pantalla en blanco ni un stack trace. Cuando la causa es una
 * integración externa sin credenciales, `integracion` nombra la integración
 * y el mensaje declara el estado "pendiente de credenciales" (REQ-UX-002,
 * ACEPTACION §criterio 10).
 */
export function EstadoError({
  titulo = "No se pudo cargar la información",
  mensaje,
  integracion,
  pendienteCredenciales = false,
  onReintentar,
}: {
  titulo?: string;
  mensaje?: string;
  /** Nombre de la integración externa que falló (ej. "PMS Cloudbeds", "API de Atiende Hoteles"). */
  integracion?: string;
  /** Marca el mensaje como bloqueo de credenciales en vez de error transitorio. */
  pendienteCredenciales?: boolean;
  onReintentar?: () => void;
}) {
  const descripcion =
    mensaje ??
    (integracion
      ? pendienteCredenciales
        ? `${integracion} está pendiente de credenciales. Conecta la integración para ver datos reales aquí.`
        : `No se pudo conectar con ${integracion}. Verifica la conexión e inténtalo de nuevo.`
      : "Ocurrió un problema al conectar con el servidor. Verifica la conexión e inténtalo de nuevo.");

  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center">
      <div className="w-11 h-11 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
        <AlertTriangle className="w-5 h-5" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{titulo}</p>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">{descripcion}</p>
        {pendienteCredenciales && (
          <p className="mt-2 inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            Pendiente de credenciales
          </p>
        )}
      </div>
      {onReintentar && (
        <Button type="button" variant="outline" size="sm" onClick={onReintentar}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
