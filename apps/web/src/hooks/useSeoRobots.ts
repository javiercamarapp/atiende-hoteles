// H12b · LAUNCH-028: "noindex del panel, index solo de páginas públicas" (docs/
// referencia/08-inventario-punta-a-punta.md fila 28). El shell es una SPA con un único
// index.html — sin este hook, el <meta name="robots" content="noindex, nofollow">
// global de index.html bloquearía también las páginas públicas (/terminos, /privacidad)
// que sí conviene que un buscador indexe. Al montar una página pública, se relaja el
// meta tag a "index, follow"; al desmontarla, se restaura el default seguro del panel
// (noindex, nofollow) — cualquier ruta que NO llame a este hook se queda con el default
// del documento, que es el correcto para el 100% del panel operativo.
import { useEffect } from "react";

const DEFAULT_ROBOTS = "noindex, nofollow";

export function useSeoRobots(content: string): void {
  useEffect(() => {
    const meta = document.querySelector('meta[name="robots"]');
    if (!meta) return;
    const previo = meta.getAttribute("content") ?? DEFAULT_ROBOTS;
    meta.setAttribute("content", content);
    return () => meta.setAttribute("content", previo);
  }, [content]);
}
