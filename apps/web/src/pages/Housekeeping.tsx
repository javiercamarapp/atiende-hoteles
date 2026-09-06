import { Sparkles } from "lucide-react";
import { ListaTickets } from "../components/ListaTickets";

export function Housekeeping() {
  return (
    <ListaTickets
      area="housekeeping"
      titulo="Housekeeping"
      descripcion="Tickets de limpieza y preparación de habitación por prioridad y estado."
      icono={Sparkles}
    />
  );
}
