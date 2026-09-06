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
- Hay red npm (`@electric-sql/pglite@0.5.8`, `supabase@2.116.0` resolvibles; `vitest@4.1.11` resuelto en instalación real — ver nota bajo este bloqueo). Chrome 152 disponible para render headless. `gh` autenticado (javiercamarapp).
- Decisión de stack tomada por el agente de arquitectura (Sonnet) y documentada en `docs/ARQUITECTURA.md` ADR-003: **solo para el entorno local de desarrollo/pruebas de esta máquina** (PGlite + `embedded-postgres`), sin tocar la decisión de producción — ver D-001 abajo. No se instalan paquetes de sistema sin autorización.

## D-001 — Decisión pendiente del usuario: ¿producción sigue sobre Supabase gestionado, o se evalúa Postgres autogestionado? (EXPUESTA, no bloquea trabajo local)
- **Fecha:** 2026-09-05
- **Qué dice cada fuente:** H20 (`docs/referencia/03-investigacion-H12-H21.md:151`) fija Supabase multi-tenant (Postgres cloud gestionado + RLS + GoTrue + PostgREST) como plataforma de datos de **producción**. `REQ-GOB-012`/`REQ-AGT-011` (fuentes GOB-051/LLM-022) fijan que cualquier cambio de proveedor de BD requiere decisión reservada al fundador, registrada antes de mergear/ejecutar.
- **Qué se hizo en este repo:** `docs/ARQUITECTURA.md` ADR-003 usa Postgres local (PGlite para pruebas unitarias, `embedded-postgres` para integración/concurrencia) **exclusivamente como entorno de desarrollo y pruebas en esta máquina**, porque Docker/Supabase CLI no funcionan aquí (B-002). El esquema y las políticas RLS se mantienen compatibles con Supabase (`auth.uid()`/claims JWT) para poder apuntar a un proyecto Supabase real sin reescribir RLS. **No se decidió, ni se propone aquí, abandonar Supabase en producción.**
- **Qué necesita decidir el fundador (no bloquea el trabajo local, sí bloquea el paso a producción):** (1) confirmar que producción seguirá sobre un proyecto Supabase gestionado (proveer el proyecto/credenciales cuando corresponda), o (2) si en algún momento se propusiera operar producción sobre Postgres autogestionado en vez de Supabase, esa es la decisión de "cambio de proveedor de BD" que `REQ-GOB-012`/`REQ-AGT-011` reservan exclusivamente al fundador — requiere aprobación explícita registrada antes de tomarse, nunca por conveniencia técnica de un entorno de desarrollo.
- **Acción tomada mientras tanto:** ninguna decisión de producción se toma por defecto; el trabajo de esquema/RLS/migraciones continúa en el entorno local compatible, sin cerrar la opción de Supabase remoto.
- **Intentos:** 0 (no es un bloqueo técnico; es una decisión reservada al fundador que se expone aquí para que quede registrada y visible, no para detener el ciclo de construcción local).
