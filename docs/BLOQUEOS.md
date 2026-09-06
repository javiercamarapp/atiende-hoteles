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
- **Estado 2026-09-05 (cierre de sesión de bucle):** trabajo independiente (requisitos, aceptación, arquitectura, protocolo de auditoría, auditoría-0) COMPLETADO; el bucle se detuvo conforme al encargo. Para continuar hace falta la ruta destino (o autorización explícita para construir el código en el repo provisional).

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

## D-002 — Decisión pendiente del usuario: confirmar la Opción C (Anthropic Sonnet 5/Haiku 4.5/Opus 5) como decisión LLM definitiva, o mantenerla como default reversible (EXPUESTA, no bloquea trabajo)
- **Fecha:** 2026-09-05
- **Qué dice la fuente:** `DECISIONLLMHOTELES` (contradicción #6 de `docs/REQUISITOS.md:410`) recomienda la Opción C como estándar de producto (LLM-008) pero la declara explícitamente "propuesta para decisión humana" (decisión #7 del catálogo externo `DECISIONS-HUMANAS.pdf`, citado en `docs/referencia/01-blueprint-y-decision-llm.md:370,396` — ese PDF no existe como archivo local `docs/DECISIONS-HUMANAS.md` en este repositorio, solo en la carpeta de fuentes de referencia; este bloqueo D-002 es el registro local equivalente); mientras no haya decisión del fundador, el loop de construcción sigue con esa opción por defecto.
- **Qué se hizo en este repo:** `docs/ARQUITECTURA.md` ADR-006 y la sección "Resolución de las 10 contradicciones" (punto 6) documentan que se construye con la Opción C como default, sin tratarla como decisión cerrada; un cambio de proveedor de modelo sigue reservado al fundador (`REQ-AGT-011`/`REQ-GOB-012`).
- **Qué necesita decidir el fundador:** confirmar la Opción C como definitiva, o indicar una alternativa (Opción A/B, documentadas como plan de contingencia en LLM-024) antes de comprometerse a integraciones irreversibles con proveedores de esa opción.
- **Acción tomada mientras tanto:** se sigue construyendo sobre la Opción C sin cerrar la puerta a un cambio; ningún commit trata esta elección como definitiva.
- **Intentos:** 0 (decisión reservada al fundador, no un bloqueo técnico).

## D-003 — Decisión pendiente del usuario: umbrales y contenido de los protocolos de huracán/sargazo (EXPUESTA, no bloquea trabajo)
- **Fecha:** 2026-09-05
- **Qué dice la fuente:** GOB-052 reserva explícitamente al fundador "protocolos de huracán (umbrales de aviso, mensajes masivos)"; `REQ-HUE-025`/`REQ-HK-017`/`REQ-REC-013` fijan las ventanas de fase (72/48/24h) pero no los umbrales exactos de activación ni el contenido/aprobación de los mensajes masivos de la fase crítica.
- **Qué se hizo en este repo:** `docs/ARQUITECTURA.md` "Resolución de las 10 contradicciones" (punto 2) resuelve el mecanismo técnico de reconciliación de la copia local cifrada con Supabase (mismo patrón de Outbox/command bus idempotente que los conectores externos), dejando explícitamente fuera de esa resolución los umbrales/contenido del protocolo en sí.
- **Qué necesita decidir el fundador:** los umbrales de activación por fase y el criterio de aprobación humana del contenido de los mensajes masivos de la fase 24h (ya exigida como aprobación obligatoria por `REQ-HUE-025`, pero el criterio de qué decir/cuándo activarlo es del fundador).
- **Acción tomada mientras tanto:** el mecanismo técnico de sincronización offline se construye igual; solo la política de umbrales/contenido queda pendiente.
- **Intentos:** 0 (decisión reservada al fundador, no un bloqueo técnico).

## D-004 — Decisión pendiente del usuario: integración de cerraduras y módulo "hotel sin recepción nocturna" (EXPUESTA, no bloquea trabajo)
- **Fecha:** 2026-09-05
- **Qué dice la fuente:** GOB-052 reserva al fundador, como dos ítems separados, "control físico de AC/cerraduras/emisión de llaves" y el modo "hotel sin recepción nocturna". `REQ-GOB-018` ya fija que ambos son de fase posterior, no del alcance inicial.
- **Qué se hizo en este repo:** ADR-011 construye el contrato `LockPort` con la garantía de autenticación fuerte + evento del PMS antes de emitir una llave, y su adaptador simulado, sin activar ninguna integración real de cerraduras ni el módulo "sin recepción nocturna". La contradicción #9 de `docs/REQUISITOS.md` (H07-039/BP-094 vs. GOB-052/BP-066/BP-092) se deja expresamente sin resolver en `docs/ARQUITECTURA.md`, remitida aquí.
- **Qué necesita decidir el fundador:** aprobar explícitamente la integración de cerraduras (proveedor, alcance) antes de construir el adaptador real de `LockPort`, y aprobar por separado el módulo "hotel sin recepción nocturna" antes de ofrecerlo en producto (`REQ-GOB-018` ya exige además ≥5-8 hoteles por riesgo REPSE para la variante de staff compartido).
- **Acción tomada mientras tanto:** se construye y prueba solo el contrato + adaptador simulado de `LockPort`; ninguna integración real ni el módulo "sin recepción nocturna" se activan.
- **Intentos:** 0 (decisión reservada al fundador, no un bloqueo técnico).
