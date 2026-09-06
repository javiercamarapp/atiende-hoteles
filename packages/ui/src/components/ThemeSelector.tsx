import { useEffect, useState } from "react";
import { Sun, Monitor, Moon } from "lucide-react";

// Portado 1:1 desde atiende-restaurantes (src/components/ThemeSelector.tsx):
// mismo localStorage key, mismo comportamiento ("sistema" solo se
// reevalúa mientras el usuario lo tenga elegido explícito), mismo
// role="radiogroup"/aria-checked (REQ-UX-001, ACEPTACION §5).
const KEY = "atiende-tema";
type Tema = "claro" | "sistema" | "oscuro";

function leerTema(): Tema {
  const v = window.localStorage.getItem(KEY);
  return v === "oscuro" || v === "sistema" ? v : "claro";
}

function aplicar(tema: Tema) {
  const oscuro = tema === "oscuro" || (tema === "sistema" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", oscuro);
}

const OPCIONES: Array<{ valor: Tema; Icono: typeof Sun; rotulo: string }> = [
  { valor: "claro", Icono: Sun, rotulo: "Tema claro" },
  { valor: "sistema", Icono: Monitor, rotulo: "Seguir al sistema" },
  { valor: "oscuro", Icono: Moon, rotulo: "Tema oscuro" },
];

export function ThemeSelector() {
  const [tema, setTema] = useState<Tema>("claro");

  useEffect(() => {
    const t = leerTema();
    setTema(t);
    aplicar(t);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (leerTema() === "sistema") aplicar("sistema");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const elegir = (nuevo: Tema) => {
    window.localStorage.setItem(KEY, nuevo);
    setTema(nuevo);
    aplicar(nuevo);
  };

  return (
    <div role="radiogroup" aria-label="Tema de la interfaz" className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-muted">
      {OPCIONES.map(({ valor, Icono, rotulo }) => {
        const activo = tema === valor;
        return (
          <button
            key={valor}
            type="button"
            role="radio"
            aria-checked={activo}
            aria-label={rotulo}
            title={rotulo}
            onClick={() => elegir(valor)}
            className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
              activo ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Icono className="w-4 h-4" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
