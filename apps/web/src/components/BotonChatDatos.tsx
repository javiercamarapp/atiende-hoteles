// Píldora "Chatea con tus datos" del header, mismo patrón visual que
// AdminDashboard.tsx de atiende-restaurantes (botón outline rounded-full
// con MessageCircle + texto). A diferencia de Restaurantes -- donde el
// botón navega a una sección "pregunta" real -- este repo no tiene todavía
// un backend de chat-con-datos (sin ruta /pregunta, sin endpoint de
// RAG/embeddings en apps/api: se revisó antes de escribir este componente).
// Se deja visible pero deshabilitado, con un toast honesto en vez de
// simular una función que no existe -- mismo criterio que
// BannerHotelesBloqueado/SelectorHotel en este layout.
import { MessageCircle } from "lucide-react";
import { Button, toast } from "@atiende/ui";

export function BotonChatDatos({ className }: { className?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // Deliberadamente SIN `disabled` nativo: eso bloquearía el click (y con
      // él, el único aviso honesto de por qué no hace nada). En su lugar se
      // marca aria-disabled + estilo apagado y el click dispara el toast.
      aria-disabled="true"
      onClick={() =>
        toast("Esta función todavía no está conectada a tus datos reales", {
          description: "Chatea con tus datos está en el roadmap; por ahora no hay un backend real que responder.",
        })
      }
      className={`h-8 rounded-full text-[13px] shrink-0 opacity-60 hover:opacity-60 ${className ?? ""}`}
    >
      <MessageCircle className="w-3.5 h-3.5" />
      Chatea con tus datos
    </Button>
  );
}
