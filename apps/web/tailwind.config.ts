import type { Config } from "tailwindcss";
import preset from "@atiende/ui/tailwind-preset";

// Estructura calcada de atiende-restaurantes (tailwind.config.ts,
// docs/referencia/05-frontend-restaurantes.md §4.4); los tokens de color/
// radio/sombra/tipografía viven en el preset compartido de @atiende/ui
// para que packages/ui y apps/web nunca diverjan (REQ-UX-001).
export default {
  presets: [preset as Config],
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  prefix: "",
} satisfies Config;
