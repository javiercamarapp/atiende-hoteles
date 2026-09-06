import { Wrench } from "lucide-react";
import { ListaTickets } from "../components/ListaTickets";

export function Mantenimiento() {
  return (
    <ListaTickets
      area="mantenimiento"
      titulo="Mantenimiento"
      descripcion="Tickets de mantenimiento correctivo/preventivo por prioridad y estado."
      icono={Wrench}
    />
  );
}
