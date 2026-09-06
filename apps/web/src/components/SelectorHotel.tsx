import { Building2, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@atiende/ui";
import { useHotel } from "../hooks/useHotel";

/**
 * Selector de hotel (multi-hotel) del encabezado — REQ-TEN "org → location"
 * (ADR-004): una organización puede operar más de un hotel; este control
 * cambia el `hotelId` que consultan todas las pantallas. Sin backend/hoteles
 * reales, se declara honestamente en vez de listar opciones inventadas.
 */
export function SelectorHotel() {
  const { hoteles, hotelActivoId, seleccionarHotel, cargando, error } = useHotel();
  const activo = hoteles.find((h) => h.id === hotelActivoId);

  if (cargando) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 text-sm text-muted-foreground min-h-11">
        <Building2 className="w-4 h-4" strokeWidth={1.75} />
        Cargando hoteles…
      </div>
    );
  }

  if (error || hoteles.length === 0) {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-full border border-dashed border-border bg-card px-3 py-2 text-sm text-muted-foreground min-h-11"
        title={error ? error.message : "Sin hoteles conectados todavía"}
      >
        <Building2 className="w-4 h-4" strokeWidth={1.75} />
        Sin hoteles
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors min-h-11"
          aria-label="Cambiar de hotel"
        >
          <Building2 className="w-4 h-4 text-primary" strokeWidth={1.75} />
          <span className="truncate max-w-[10rem]">{activo?.nombre ?? "Elegir hotel"}</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Hoteles de tu organización</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hoteles.map((hotel) => (
          <DropdownMenuItem key={hotel.id} onSelect={() => seleccionarHotel(hotel.id)}>
            {hotel.nombre}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
