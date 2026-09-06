# Bloqueos

## B-001 — Carpeta "empresas agénticas" no localizada (ABIERTO)
- **Fecha:** 2026-09-05
- **Qué se buscó (evidencia, sin inventar):**
  - `find ~ -maxdepth 4 -type d -iname "*empresas*agent*"` y variantes (`agentic`, `agéntica`, `EmpresasAgenticas`) → sin resultados.
  - `find ~/Desktop ~/Documents ~/Developer ~/Projects ~/javiercamarapp -maxdepth 7 -iname "*empresa*" -o -iname "*agentic*"` → solo `~/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF` (los PDF) y listas CSV de empresas de Likida.
  - `mdfind -name empresas|agenticas|agentic` → documentos de Likida, ningún directorio con ese nombre.
  - Listados de `~`, `~/Desktop`, `~/Documents`, `~/Documents/Codex`, iCloud Drive → no existe.
- **Candidatas observadas (NO confirmadas, decisión del usuario):** `~/Documents/Codex` (donde vive `atiende-restaurantes`), `~/Desktop/INTENTO DE STARTUPS`, `~/Desktop/GitHub`.
- **Acción tomada:** trabajo de requisitos/investigación en `~/Documents/Codex/atiende-hoteles-staging` (provisional, documentado en README). No se creó ninguna carpeta llamada "empresas agénticas".
- **Qué necesita el usuario responder:** ruta exacta de la carpeta (o autorizar una candidata).
- **Intento 2 (2026-09-05, Sonnet #11):** grep en wiki 'mi memoria claude', wiki-sync-inbox, memoria de Claude, ~/.codex ~/.grok ~/.gemini ~/.antigravity ~/.openclaw, ~/.zsh_history, y listados de Desktop/GitHub, INTENTO DE STARTUPS, Escritorio/Documentos Mac mini y Google Drive 'Mi unidad' → **ninguna mención**. Detalle: docs/evidencia-B-001-busqueda-ampliada.md.
- **Intentos:** 2 sin progreso. Búsqueda local agotada; solo el usuario puede resolverlo.

## B-002 — Toolchain local sin Docker/Supabase CLI/Postgres (ABIERTO, con trabajo independiente)
- `docker`, `supabase`, `deno`, `psql`, `pg_ctl` no están instalados. Restaurantes depende de Supabase+Deno.
- Hay red npm (`@electric-sql/pglite@0.5.8`, `supabase@2.116.0`, `vitest@5.0.0` resolvibles). Chrome 152 disponible para render headless. `gh` autenticado (javiercamarapp).
- Decisión de stack pendiente del agente de arquitectura (Sonnet): persistencia real sin Docker (PGlite embebido / Postgres portable) vs. exigir instalación al usuario. No se instalan paquetes de sistema sin autorización.
