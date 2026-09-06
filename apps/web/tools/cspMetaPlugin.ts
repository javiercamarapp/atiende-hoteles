// H12b · LAUNCH-021 "completar CSP" para apps/web: la SPA se sirve como archivos
// estáticos en Vercel (sin servidor propio que añada cabeceras por request), y
// `vercel.json` (headers estáticos) no admite interpolar `VITE_API_URL`/
// `VITE_SUPABASE_URL` -- esos valores solo se conocen en tiempo de BUILD, no al
// escribir `vercel.json`. Este plugin resuelve exactamente eso: en cada `vite build`,
// lee las variables de entorno del modo actual (mismo mecanismo que `import.meta.env`)
// e inyecta un `<meta http-equiv="Content-Security-Policy">` con `connect-src`
// apuntando al API/Supabase de ESE entorno.
//
// Cabeceras que la etiqueta <meta> NO puede expresar (frame-ancestors, X-Frame-Options,
// HSTS, etc.) viven en `apps/web/vercel.json` -- ver ese archivo y `deploy/README.md`
// "Por qué CSP en dos sitios".
//
// Nada de `unsafe-inline`/`unsafe-eval` en `script-src`: `index.html` carga UN solo
// script externo (`/src/main.tsx` compilado), sin ningún `<script>` inline -- a
// diferencia de una app Next.js con streaming/App Router, una SPA de Vite no inyecta
// scripts inline en el HTML servido. `style-src` sí necesita `'unsafe-inline'`: varios
// componentes usan `style={{...}}` (atributo, no `<style>` de bloque) para aplicar
// tokens de diseño calculados en render -- un hash/nonce no cubre atributos dinámicos
// (solo cubriría un `<style>` o `<script>` de contenido FIJO), así que la única
// alternativa real sería reescribir esos componentes a clases CSS estáticas, fuera de
// alcance de esta entrega. Documentado, no un descuido.
import type { Plugin, UserConfig } from "vite";

export interface CspMetaOptions {
  /** Orígenes adicionales de `connect-src`, ya resueltos (ej. VITE_API_URL, VITE_SUPABASE_URL). */
  connectSrcExtra: (string | undefined)[];
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

export function buildCsp(connectSrcExtra: (string | undefined)[]): string {
  const connectSrc = ["'self'", ...connectSrcExtra.filter((v): v is string => Boolean(v))].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    // `https://fonts.googleapis.com`: `packages/ui/src/index.css` importa la hoja de
    // Google Fonts con `@import url(...)` -- eso es CSS remoto, gobernado por
    // `style-src`, no por `font-src` (los archivos .woff2 en sí SÍ vienen de
    // fonts.gstatic.com, cubiertos por `font-src` más abajo).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src ${connectSrc}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function cspMetaPlugin(): Plugin {
  let resolvedConfig: UserConfig & { env?: Record<string, string> };

  return {
    name: "atiende-hoteles-csp-meta",
    configResolved(config) {
      resolvedConfig = config as unknown as UserConfig & { env?: Record<string, string> };
    },
    transformIndexHtml(html) {
      const env = (resolvedConfig as unknown as { env?: Record<string, string> })?.env ?? {};
      const apiUrl = env.VITE_API_URL as string | undefined;
      const supabaseUrl = env.VITE_SUPABASE_URL as string | undefined;
      const csp = buildCsp([apiUrl, supabaseUrl]);
      return html.replace(
        "</title>",
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}" />`,
      );
    },
  };
}
