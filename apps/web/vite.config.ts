import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Puerto directo de vite.config.ts de atiende-restaurantes (docs/referencia/
// 05-frontend-restaurantes.md §4.4): plugin React SWC, alias "@" → "./src",
// chunkSizeWarningLimit. `base` es "/" (Hoteles no despliega en subpath como
// Restaurantes) y se añade el alias "@atiende/ui" apuntando al código fuente
// del paquete (sin paso de build propio, ver packages/ui/package.json).
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@atiende/ui/styles.css": path.resolve(import.meta.dirname, "../../packages/ui/src/index.css"),
      "@atiende/ui": path.resolve(import.meta.dirname, "../../packages/ui/src/index.ts"),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
  },
});
