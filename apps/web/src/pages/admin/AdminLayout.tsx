// H12b · LAUNCH-007: shell de la consola superadmin cross-tenant (`/admin/*`). Misma
// identidad visual que el resto del panel (AtiendeWordmark, tokens de `packages/ui`), pero
// deliberadamente SIN el sidebar/hotel-selector de `AppShell.tsx` (esta consola no está
// acotada a un hotel — mostrar el selector de hotel activo aquí sería sugerir, de forma
// falsa, que la vista está filtrada a uno) y sin tocar ese archivo (propiedad de otro
// lote en paralelo).
//
// La autorización real vive en el servidor (`is_platform_admin()`/`requirePlatformAdmin`,
// ver apps/api/src/routes/admin.ts): esta capa NO intenta adivinar el rol del usuario
// antes de preguntarle a la API — cualquier staff con sesión puede navegar aquí, y cada
// subpágina muestra el 403 explícito de la API vía `DataState`/`EstadoError` si no es
// superadmin de plataforma (mismo patrón "nunca inventar un dato" que el resto del panel).
import { NavLink, Outlet } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { AtiendeWordmark } from "@atiende/ui";
import { useAuth } from "../../hooks/useAuth";

const TABS = [
  { to: "/admin", label: "Negocio", end: true },
  { to: "/admin/costo-ia", label: "Costo de IA" },
  { to: "/admin/salud", label: "Salud" },
  { to: "/admin/auditoria", label: "Auditoría" },
];

export function AdminLayout() {
  const { sesion, cerrarSesion } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AtiendeWordmark className="h-6 w-auto" />
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-900 text-xs font-medium px-2.5 py-1 dark:bg-amber-950 dark:text-amber-200">
              <ShieldAlert className="w-3.5 h-3.5" strokeWidth={2} />
              Consola superadmin — cruza todos los hoteles a propósito
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <NavLink to="/resumen" className="text-muted-foreground hover:text-foreground">
              Volver al panel de hotel
            </NavLink>
            {sesion && (
              <button type="button" onClick={cerrarSesion} className="text-muted-foreground hover:text-foreground">
                Salir ({sesion.email})
              </button>
            )}
          </div>
        </div>
        <nav className="max-w-6xl mx-auto px-4 flex gap-1 -mb-px">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `px-3 py-2 text-sm border-b-2 ${
                  isActive ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="contenido-principal" className="max-w-6xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
