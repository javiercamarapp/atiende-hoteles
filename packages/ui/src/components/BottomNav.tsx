import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface BottomNavItem {
  to: string;
  label: string;
  icon: IconType;
  /** Conteo real a mostrar como badge; nunca inventar un número — omitir si no hay dato. */
  count?: number;
}

export interface BottomNavProps {
  items: BottomNavItem[];
}

/**
 * Bottom-nav móvil real — cierra el hueco de mobile de atiende-restaurantes
 * (docs/referencia/05-frontend-restaurantes.md §2.5/§2.6: "el panel admin de
 * restaurantes no tiene una experiencia mobile real", solo el flujo del
 * repartidor la resuelve). Mismo patrón que
 * `RepartidorDashboard.tsx` (header+bottom-nav fijos `md:hidden`,
 * `safe-area-bottom`), portado para el personal operativo de hotel
 * (recepción/housekeeping/mantenimiento). Controles ≥44px (REQ-UX-003).
 */
export function BottomNav({ items }: BottomNavProps) {
  return (
    <nav
      aria-label="Navegación móvil"
      className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 safe-area-bottom"
    >
      <div className="flex justify-around items-stretch py-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "relative flex flex-col items-center justify-center gap-1 min-w-[64px] min-h-11 px-2 py-2 rounded-lg",
                isActive ? "text-primary" : "text-muted-foreground",
              )
            }
          >
            <item.icon className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-[10px] leading-none">{item.label}</span>
            {typeof item.count === "number" && item.count > 0 && (
              <span className="absolute top-0.5 right-2 bg-destructive text-destructive-foreground text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {item.count}
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/**
 * Header fijo móvil (logo + acción), pareja del BottomNav — mismo patrón
 * `md:hidden fixed top-0 ... safe-area-top` de `RepartidorDashboard.tsx`.
 */
export function MobileHeader({
  title,
  action,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="md:hidden fixed top-0 left-0 right-0 bg-card border-b border-border z-50 safe-area-top">
      <div className="flex items-center justify-between px-4 py-3 min-h-14">
        {title}
        {action}
      </div>
    </header>
  );
}
