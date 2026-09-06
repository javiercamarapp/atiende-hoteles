import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { sembrarSesionFalsa } from "./utils/session";

// REQ-UX-003 / ACEPTACION §3 punto 11: suite axe-core sobre login/resumen/
// reservas → falla si hay violaciones "serious" o "critical" (las de menor
// impacto se reportan pero no bloquean, igual que la mayoría de gates axe en
// CI reales).
const RUTAS: Array<{ nombre: string; ruta: string; protegida: boolean }> = [
  { nombre: "login", ruta: "/login", protegida: false },
  { nombre: "resumen", ruta: "/resumen", protegida: true },
  { nombre: "reservas", ruta: "/reservas", protegida: true },
  // H4: grid de disponibilidad y formularios de tarifas/impuestos/política de
  // cancelación en Configuración.
  { nombre: "disponibilidad", ruta: "/disponibilidad", protegida: true },
  { nombre: "configuracion", ruta: "/configuracion", protegida: true },
  // H6b: tablero de housekeeping, tickets de mantenimiento, mensajería y bandeja de
  // aprobaciones (móvil real para camaristas/mantenimiento, REQ-UX-001/003).
  { nombre: "housekeeping", ruta: "/housekeeping", protegida: true },
  { nombre: "mantenimiento", ruta: "/mantenimiento", protegida: true },
  { nombre: "mensajeria", ruta: "/mensajeria", protegida: true },
  { nombre: "aprobaciones", ruta: "/aprobaciones", protegida: true },
];

for (const { nombre, ruta, protegida } of RUTAS) {
  test(`axe: ${nombre} sin violaciones serias/críticas`, async ({ page }) => {
    if (protegida) await sembrarSesionFalsa(page);
    await page.goto(ruta);
    await page.waitForLoadState("networkidle");

    const resultados = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const graves = resultados.violations.filter((v) => v.impact === "serious" || v.impact === "critical");

    if (graves.length > 0) {
      console.log(`Violaciones graves en ${nombre}:`, JSON.stringify(graves, null, 2));
    }
    expect(graves, `Violaciones axe serias/críticas en ${nombre}`).toEqual([]);
  });
}
