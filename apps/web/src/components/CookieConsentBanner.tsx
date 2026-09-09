// H12c · Banner de cookies/analítica -- opt-in explícito (nunca activo por defecto).
// Se muestra en CUALQUIER pantalla (pública o del panel) mientras no haya una decisión
// guardada localmente. Aceptar/rechazar activa/mantiene desactivado
// `packages/analytics` (ver lib/analytics.ts) -- respeta el aviso de privacidad del
// lote A (pages/Privacidad.tsx, enlazado aquí, no editado por este hito).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@atiende/ui";
import { leerConsentimiento, otorgarConsentimiento, revocarConsentimiento } from "../lib/analytics";

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(leerConsentimiento() === null);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Consentimiento de cookies y analítica"
      className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4 flex justify-center"
    >
      <Card className="w-full max-w-3xl p-4 sm:p-5 shadow-lg border-border flex flex-col sm:flex-row sm:items-center gap-3">
        <p className="text-sm text-muted-foreground flex-1">
          Usamos analítica de producto para entender qué funciona del panel y mejorarlo. No la activamos sin tu permiso, y nunca
          incluye datos de huéspedes ni información personal identificable. Puedes leer el detalle en el{" "}
          <Link to="/privacidad" className="text-primary underline underline-offset-2">
            aviso de privacidad
          </Link>
          .
        </p>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              revocarConsentimiento();
              setVisible(false);
            }}
          >
            Rechazar
          </Button>
          <Button
            size="sm"
            onClick={() => {
              otorgarConsentimiento();
              setVisible(false);
            }}
          >
            Aceptar analítica
          </Button>
        </div>
      </Card>
    </div>
  );
}
