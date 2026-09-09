import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
import { cspMetaPlugin } from "./tools/cspMetaPlugin.ts";

// Puerto directo de vite.config.ts de atiende-restaurantes (docs/referencia/
// 05-frontend-restaurantes.md §4.4): plugin React SWC, alias "@" → "./src",
// chunkSizeWarningLimit. `base` es "/" (Hoteles no despliega en subpath como
// Restaurantes) y se añade el alias "@atiende/ui" apuntando al código fuente
// del paquete (sin paso de build propio, ver packages/ui/package.json).
//
// H12b · LAUNCH-021: `cspMetaPlugin()` inyecta la CSP con `connect-src` resuelto por
// entorno (VITE_API_URL/VITE_SUPABASE_URL) — ver apps/web/tools/cspMetaPlugin.ts.
export default defineConfig({
  base: "/",
  plugins: [react(), cspMetaPlugin()],
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
