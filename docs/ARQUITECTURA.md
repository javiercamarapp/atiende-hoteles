# Arquitectura — Atiende Hoteles

Decisiones de arquitectura (ADR) para construir Atiende Hoteles en esta máquina (macOS arm64, Node v25.6.1, npm 11.12.1, Chrome 152, `gh` autenticado; sin Docker/Supabase CLI funcional/Deno/pnpm/psql — ver `docs/BLOQUEOS.md` B-002). Cada ADR cita el archivo/sección exacto de `docs/referencia/` que la sustenta y declara qué prueba la verificaría. Las integraciones que exigen credenciales (WhatsApp Cloud, PMS, pasarela, CFDI, ElevenLabs/LiveKit, Supabase remoto) quedan explícitamente como "integración pendiente" con puerto+adaptador+contrato, nunca marcadas completas por un mock.

Convención de estado por ADR: **[DECIDIDO]** aplica ya en el código; **[PENDIENTE DE CREDENCIALES]** tiene contrato+adaptador+prueba de contrato pero no corre contra el proveedor real.

---

## ADR-001 — Forma del repositorio: monorepo npm workspaces + Turborepo (no pnpm)

**Contexto.** H20 fija diez decisiones de stack, la novena de las cuales es "Monorepo: pnpm + Turborepo" (`docs/referencia/03-investigacion-H12-H21.md` §3.1, punto 9), y la primera es "un solo núcleo, dos dominios": `packages/domain-hotel` montado sobre el mismo Supabase multi-tenant, mismo `agent-runtime`, mismos MCP servers y mismo `voice-agent` que la línea de restaurantes, con `location.kind='hotel'` bajo la misma `org` (mismo §3.1, punto 1). El encargo prohíbe modificar `atiende-restaurantes` o su `.git` (instrucción del usuario, `/private/tmp/atiende-hoteles-encargo.md`). `docs/referencia/07-stack-viabilidad.md` confirma que `pnpm`, `docker`, `deno`, `psql`, `pg_ctl` no están instalados en esta máquina y que no se instalan paquetes de sistema sin autorización (`docs/BLOQUEOS.md` B-002).

**Opciones.**
1. Honrar pnpm+Turborepo tal cual, pidiendo al usuario que instale pnpm.
2. App única (sin monorepo), descartando la separación de paquetes de H20.
3. Monorepo con **npm workspaces** (ya disponible, npm 11.12.1 verificado) + **Turborepo** (el binario `turbo` es agnóstico de gestor de paquetes: soporta workspaces de npm, yarn o pnpm indistintamente — no depende de pnpm en sí, solo de la clave `workspaces` de `package.json`), replicando la misma frontera de paquetes que H20 describe (`domain-hotel`, `agent-core`, `ui`, `db`, MCP servers) dentro de un repo nuevo y separado de `atiende-restaurantes`.

**Decisión.** Opción 3. Se crea el monorepo con `npm workspaces` + `turbo` (resoluble vía npm, sin Docker ni binarios de sistema adicionales), con la misma topología de paquetes que H20 exige (ver estructura de carpetas al final), para que una futura fusión física con `atiende-restaurantes` bajo pnpm sea un cambio mecánico de gestor de paquetes, no de arquitectura. No se funde físicamente con `atiende-restaurantes` en esta fase: se trata como repositorio hermano de solo lectura (regla explícita del encargo), y `packages/domain-hotel` se construye aquí con las mismas interfaces (tipos, esquemas Zod, contratos JSON) que H20 describe para que el "60-70% de reutilización de código" estimado (H20, mismo documento, nota `[E]`) sea técnicamente alcanzable después.

**Evidencia.** `docs/referencia/03-investigacion-H12-H21.md` §3.1 (puntos 1 y 9); `docs/referencia/07-stack-viabilidad.md` "Hechos de entorno verificados" (`which docker supabase deno bun pnpm psql pg_ctl` → todos ausentes); `docs/BLOQUEOS.md` B-002.

**Consecuencias.** Se puede migrar a pnpm con `pnpm import` (lee `package-lock.json`) sin reescribir `turbo.json` ni la topología de paquetes. La fusión real con `atiende-restaurantes` (mismo Supabase, mismo `agent-runtime`) queda como trabajo posterior, documentado como desvío en la tabla final, no como incumplimiento.

**Prueba que lo verifica.** `npm install` resuelve el árbol de workspaces sin error; `npx turbo run build --dry` lista las tareas de todos los paquetes declarados; CI (ADR-009) ejecuta `turbo run lint typecheck test` en un solo comando sobre todo el monorepo.

---

## ADR-002 — Frontend: Vite+React+TS+shadcn+Tailwind con identidad de Restaurantes, navegación hotelera y mobile real

**Contexto.** `docs/referencia/05-frontend-restaurantes.md` documenta el stack exacto de `atiende-restaurantes` (Vite 8 + React 18.3.1 + TypeScript 5.8.3 + shadcn/ui + Tailwind 3.4.17), su identidad visual (logo SVG inline, tipografías Inter/Inter Tight/IBM Plex Mono, tokens HSL "white/blue/sky-blue"), su catálogo de 43 primitivos shadcn, sus patrones de sidebar/estados vacíos-carga-error, y dos hallazgos de auditoría propios: **no hay experiencia mobile real en el panel admin** (§2.5: `AdminDashboard` en mobile solo renderiza un header, el contenido completo es `hidden md:flex`) y **no hay pruebas de accesibilidad automatizadas** (§2.8, cita `docs/audits/enterprise-remediation-2026-09-04.md` severidad 7). El encargo exige "experiencia móvil" y "accesibilidad" como criterios de aceptación explícitos.

**Opciones.**
1. Copiar el frontend de Restaurantes tal cual, incluyendo el hueco de mobile.
2. Reconstruir el frontend desde cero sin reutilizar Restaurantes.
3. Portar la identidad y los primitivos reutilizables literalmente, adaptar los patrones de dominio (sidebar, secciones CRUD) a navegación hotelera, y **cerrar explícitamente el hueco de mobile** usando el patrón que sí funciona en el mismo repo de referencia (`RepartidorDashboard.tsx`: header fijo + bottom-nav `md:hidden`, `safe-area-top/bottom`), porque recepción/housekeeping/mantenimiento operan desde tablet/celular.

**Decisión.** Opción 3.

**Archivos a portar tal cual** (05 §6.1, sin secretos): `tailwind.config.ts` (estructura; tokens se redefinen), `postcss.config.js`, `components.json`, `eslint.config.js`, `tsconfig*.json`, `vite.config.ts` (cambiar `base` y `manualChunks`), `src/lib/utils.ts` (`cn`), `src/hooks/use-mobile.tsx`, `src/hooks/use-toast.ts`, los 43 primitivos de `src/components/ui/*.tsx` (evaluar si adoptar `sidebar.tsx`, confirmado sin uso real en Restaurantes — 05 §3.6), `src/components/ThemeSelector.tsx`.

**Archivos a adaptar** (05 §6.2, misma anatomía, dominio distinto): `src/index.css` (mantener estructura de tokens/gradientes/sombras/animaciones; paleta propia de Hoteles o mismo azul/cielo), `src/components/AtiendeLogo.tsx` (mismo patrón SVG inline), `src/App.tsx` (mismo patrón lazy+ErrorBoundary+rutas, rutas hoteleras nuevas), `AdminSidebar.tsx` → base del sidebar hotelero (acordeón/colapso/bloque de cuenta) con `menuSections` nuevo (Resumen, Reservas, Disponibilidad/Habitaciones, Huéspedes, Recepción/Check-in-out, Housekeeping, Mantenimiento, A&B, Mensajería/Agentes, Reputación, Back office, Configuración — mapa completo en 05 §5), `RepartidorSidebar.tsx` → base para navegación de rol operativo móvil (housekeeping/mantenimiento), `StatCard`/`TrendStatCard` (reutilización literal, cambian los datos: ocupación/ADR/RevPAR en vez de pedidos), `ModalFormularioLateral.tsx`/`ModalFormularioElegante.tsx` (shells literales), `ClientesSection.tsx` → base de "Huéspedes", `PedidosSection.tsx`/`HistorialOrdenesSection.tsx` → base de "Reservas" (tabs, filtros de fecha, export), `NotificacionesSection.tsx` → base de "Reputación"/centro de eventos, `SucursalesSection.tsx` → base de "Habitaciones"/multi-propiedad, `AdminLogin.tsx`+`login.css` (mismo flujo de auth, propio JWT en vez de Supabase Auth — ver ADR-004), `SuperAdminDashboard.tsx` → back office multi-hotel.

**No portar sin decisión explícita** (05 §6.3): `ui/sidebar.tsx` (sin consumidores reales en el origen), `CampoPixeles.tsx` (decorativo), `WidgetWhatsApp.tsx`/`ModalClonarVoz.tsx`/`SelectorIdiomasAgente.tsx` (dependen de infraestructura de agentes ElevenLabs/edge functions — portar junto con esa integración, no antes), assets de marca del piloto de restaurantes (`orbe-agente.mp4`, `login-hero.png`).

**Mobile real (cierre del hueco identificado en 05 §2.5-2.6).** El panel de recepción/gerencia usa el layout desktop de `AdminSidebar` en `md:` hacia arriba; para housekeeping/mantenimiento y para el panel de recepción en tablet se implementa el patrón ya probado de `RepartidorDashboard.tsx`: header fijo `md:hidden` + bottom-nav fija `md:hidden` con badges, `main` con padding distinto en mobile/desktop, `safe-area-top`/`safe-area-bottom` (verificar la utilidad exacta antes de portar, nota de 05 §2.6).

**Estados vacío/carga/error.** Se combina el patrón textual de Restaurantes ("Sin datos"/"Sin datos aún" en vez de simular cifras, `LoadingScreen`, `RouteErrorBoundary` con `role="alert"`) con los tres componentes explícitos de Likida (`docs/referencia/06-backoffice-agentes-likida.md` §3.5): `EstadoVacio`, `EstadoError` (con `onReintentar`), `EstadoCargando` (skeleton), porque Restaurantes documenta la *disciplina* pero no un componente `EmptyState` reutilizable — Likida sí lo tiene y es portable tal cual.

**Accesibilidad.** Se conservan los patrones positivos ya presentes (`role="status"`/`aria-busy`, `role="alert"`, `role="radiogroup"`/`aria-checked` en `ThemeSelector`, `prefers-reduced-motion` en toda animación) y se corrige el hallazgo propio del repo de referencia: se añade `aria-live="polite"` explícito en el contenedor de toasts (ausente en Restaurantes, 05 §2.8) y se incluye una suite de accesibilidad automatizada (axe vía Playwright, ver ADR-009) que Restaurantes reconoce no tener.

**Evidencia.** `docs/referencia/05-frontend-restaurantes.md` completo (§1-6, citas de línea/archivo).

**Consecuencias.** El costo de construir mobile real para housekeeping se paga una vez, en Fase H3, en vez de heredarse como deuda de Restaurantes.

**Prueba que lo verifica.** Captura Playwright/Chrome del sistema en viewport `375×812` (mobile) y `1440×900` (desktop) del sidebar hotelero y del panel de housekeeping, comparada visualmente contra las capturas equivalentes de `atiende-restaurantes` (mismo Chrome, mismos flags `--force-prefers-reduced-motion`); suite `axe-core` sin violaciones críticas en las rutas principales; prueba de `ThemeSelector` (`role`/`aria-checked`) portada 1:1.

---

## ADR-003 — Entorno LOCAL de desarrollo/pruebas: PGlite+`embedded-postgres` con esquema compatible con Supabase; producción sigue siendo Supabase (decisión no tomada por este ADR)

**Alcance de este ADR (léase antes que nada).** Este ADR decide **exclusivamente el entorno de desarrollo y pruebas en esta máquina** (cómo correr Postgres/RLS localmente sin Docker). **No decide, ni tiene autoridad para decidir, un cambio de proveedor de base de datos de producción.** H20 fija Supabase multi-tenant (Postgres cloud gestionado + RLS + GoTrue + PostgREST) como plataforma de datos de producción (`docs/referencia/03-investigacion-H12-H21.md:151`), y `REQ-GOB-012`/`REQ-AGT-011` (fuentes GOB-051/LLM-022) fijan que "cualquier cambio de proveedor de modelo/telefonía/BD... requiere decisión reservada al fundador" registrada **antes** de mergear/ejecutar. Sustituir Supabase por un Postgres propio en producción **no está decidido aquí ni en ningún otro documento de este repositorio**; sigue siendo el destino de producción por defecto. El punto se registra explícitamente como decisión pendiente del usuario en `docs/BLOQUEOS.md` D-001, sin bloquear el trabajo de desarrollo local.

**Contexto.** `docs/referencia/07-stack-viabilidad.md` es un experimento real ejecutado en esta máquina: PGlite 0.5.8 pasó 5/5 pruebas de RLS/triggers/`ON CONFLICT`/advisory lock, pero **serializa toda concurrencia** (1344 ms medidos donde debería haber ~300 ms si hubiera paralelismo real — Experimento 1). `embedded-postgres` 18.4.0-beta.17 arrancó un Postgres real (bajo Rosetta 2 en esta Mac) y demostró **concurrencia real** entre dos conexiones (302 ms medidos, Experimento 2). `npx supabase` (2.116.0) solo sirve para *scaffolding* de archivos (`init`, `migration new`, `functions new`) sin Docker; `db diff`, `gen types`, `start` fallan explícitamente pidiendo Docker incluso apuntando a un Postgres externo real (Experimento 3). Esta máquina no tiene Docker/Supabase CLI funcional (`docs/BLOQUEOS.md` B-002), lo que impide levantar un proyecto Supabase local para desarrollar/probar sin salir a internet contra un proyecto remoto.

**Opciones (para el entorno local, no para producción).**
1. Exigir al usuario instalar Docker/Supabase CLI antes de continuar (bloquea el trabajo de desarrollo hasta entonces).
2. Usar solo PGlite para todo (unitario e integración).
3. Postgres local con migraciones `.sql` versionadas a mano (usando `supabase migration new` únicamente como generador de nombre/plantilla, que sí funciona sin Docker), aplicadas por un runner propio contra dos motores según el tipo de prueba: **PGlite** para pruebas rápidas de RLS/lógica (vitest, sin proceso de SO) y **`embedded-postgres`** para integración/concurrencia real (advisory locks, idempotencia bajo contención), manteniendo el esquema **compatible con Supabase** (mismo patrón de claims que consumen las políticas RLS — `auth.uid()`/`current_setting('request.jwt.claim.sub', true)`, roles vía `set local role authenticated`) para que las mismas migraciones `.sql` y las mismas políticas RLS corran sin reescritura contra un proyecto Supabase real en cuanto exista credencial/Docker.

**Decisión.** Opción 3, **como entorno local de desarrollo y pruebas únicamente**, exactamente como recomienda `07-stack-viabilidad.md` en su sección final "Recomendación de stack". El destino de producción sigue siendo Supabase (H20); PGlite/`embedded-postgres` no sustituyen esa decisión, solo permiten avanzar la construcción y las pruebas de RLS/idempotencia/concurrencia en esta máquina mientras no haya Docker o un proyecto Supabase remoto disponible. Ningún código de esta fase asume ni codifica un proveedor de BD de producción distinto de Supabase.

**Evidencia.** `docs/referencia/07-stack-viabilidad.md` Experimentos 1-3 y "Tabla comparativa (resumen de la decisión)"; `docs/referencia/03-investigacion-H12-H21.md:151` (H20, Supabase como plataforma de producción); `docs/REQUISITOS.md` REQ-GOB-012, REQ-AGT-011; `docs/referencia/04-gobierno-y-protocolo.md:72` (GOB-051); `docs/referencia/01-blueprint-y-decision-llm.md:370` (LLM-022); `docs/BLOQUEOS.md` B-002, D-001.

**Requisitos que cubre.** REQ-TEN-001/002 (esquema compatible con RLS `org→location`), REQ-GOB-010 (RLS obligatoria); **no** cierra ni decide REQ-GOB-012/REQ-AGT-011 (ese catálogo permanece abierto y reservado al fundador para cualquier cambio real de proveedor de BD de producción).

**Consecuencias.** Ninguna prueba de contención/carrera tiene valor probatorio si corre solo en PGlite (riesgo 1 de 07-stack-viabilidad.md); toda prueba de overbooking/doble-cobro debe correr contra `embedded-postgres`. Las extensiones Postgres (`pgcrypto`, `pgjwt`, `pgsodium`, `pg_net`, `vector`) deben verificarse una por una antes de asumir portabilidad entre PGlite y `embedded-postgres` (riesgo 2). PostgREST/GoTrue (el contrato HTTP exacto de Supabase) **no** se reproduce en esta máquina — queda como integración pendiente explícita hasta tener Supabase remoto o Docker; el despliegue de producción real sobre un proyecto Supabase sigue pendiente de que el fundador provea el proyecto/credenciales, no de una decisión de arquitectura tomada aquí. Si en algún punto se propusiera **no** migrar a Supabase remoto y en su lugar operar producción sobre Postgres autogestionado, esa propuesta debe tramitarse explícitamente como el cambio de proveedor de BD que `REQ-GOB-012`/`REQ-AGT-011` reservan al fundador (ver `docs/BLOQUEOS.md` D-001) — no se activa por defecto ni por conveniencia técnica.

**Prueba que lo verifica.** Suite vitest+PGlite con aislamiento negativo de tenant (tenant A no ve/escribe filas de tenant B) corriendo en <2 s; suite vitest+`embedded-postgres` con dos clientes `pg.Client` concurrentes disputando el mismo `pg_advisory_xact_lock` sobre una reserva (equivalente a `order_idempotency_concurrency.sh` de Restaurantes); mismo archivo `.sql` de migración aplicado y verde contra ambos motores; revisión de código confirma 0 referencias a un proveedor de BD de producción distinto de Supabase fuera de `tests/`/entorno local.

---

## ADR-004 — Backend/API: Hono + JWT propio + tenant=hotel + matriz de roles + RLS por sesión + idempotencia + advisory locks + outbox + rate limits

**Contexto.** `07-stack-viabilidad.md` Experimento 4 confirma que `hono@4.13.7`, `fastify@5.12.3` y `jose@6.2.12` resuelven en el registro npm, y recomienda "servidor Node/TS propio (Hono o Fastify) + JWT propio (`jose`) + Postgres RLS", reproduciendo el patrón de Restaurantes (`set local role authenticated` + `set_config('request.jwt.claim.sub', …)` por transacción). H15-016 fija el pipeline de integración obligatorio: Ingress universal → RawEvent inmutable → `Adapter.normalize` → command bus idempotente → Reducer transaccional → Outbox → stream. GOB-010/038/042/043 fijan RLS+tenant_id obligatorios, idempotencia `[tenant_id, idempotency_key]`, rate limits por número/tenant/país. `docs/referencia/06-backoffice-agentes-likida.md` §2.2-2.3 documenta patrones de producción verificados en código real (no solo teoría): mutex con tres estados (`obtenido|ocupado|indeterminado`, fail-cerrado ante error transitorio), presupuesto de tiempo por invocación compartido entre etapas (`acotada()` como techo duro de toda consulta).

**Opciones para el framework HTTP.**
1. Fastify: ecosistema de plugins más maduro, pero más pesado y atado a Node.
2. Hono: más ligero, agnóstico de runtime (Node, Deno, Bun, Cloudflare Workers), con validación nativa vía Zod (`@hono/zod-validator`) y RPC tipado.

**Decisión de framework.** **Hono**, porque es agnóstico de runtime: `atiende-restaurantes` usa Supabase Edge Functions sobre **Deno** (`docs/referencia/05-frontend-restaurantes.md` §4.3, script `test:edge` = `deno test`); Hono corre igual sobre Node y Deno, así que un handler escrito hoy en Node/Hono se porta a Deno/Supabase Edge Functions con cambios mínimos si el proyecto migra a Supabase remoto (ADR-003), a diferencia de Fastify, que es Node-only. Esto reduce directamente el costo del desvío documentado en ADR-003.

**Tenant y organización (corregido: tenant = `org`, no `hotel`).** El límite de aislamiento multi-tenant (`tenant_id`, RLS) es la `org` — igual que exige `REQ-TEN-002` y la fuente H20 (`docs/referencia/03-investigacion-H12-H21.md:151`, "Multi-tenant sobre Postgres/Supabase con RLS (`org → location`)"). Cada hotel es una `location` con `kind='hotel'` **bajo** esa `org`; una `org` de un solo hotel sigue existiendo como fila propia (no es un caso especial). `tenant_id` en toda tabla del dominio (`REQ-TEN-001`) referencia el `org_id`, nunca el `hotel_id` directamente. Dentro de un mismo `org` con varios hoteles, el acceso se acota además por `hotel_id` (scope secundario, no de aislamiento entre tenants): un usuario tiene rol por `hotel` vía la tabla `hotel_staff` (mismo patrón que el experimento de 07-stack-viabilidad, `is_hotel_staff` security-definer calco de `is_restaurant_staff`), y la política RLS exige `org_id = ANY(current_tenant_ids())` **y**, cuando el recurso es de un hotel específico, `hotel_id = ANY(current_hotel_ids())`. Esto corrige la lectura anterior de este ADR (que invertía tenant/hotel respecto a `REQ-TEN-002`); ver hallazgo de auditoría-0 "modelo de tenencia contradictorio".

**Matriz mínima de roles** (deriva de H16 §USALI/roles, H13 personal, 06 §3.3 separación de áreas por rol de Likida, GOB-052 control físico/dinero):

| Rol | Alcance | Puede aprobar dinero/efectos externos | Ve back office multi-hotel |
|---|---|---|---|
| `superadmin` | Plataforma, cross-tenant | Sí (auditoría, no operación diaria) | Sí — única función cross-tenant, aislada (patrón `getResumenNegocio` de Likida, 06 §3.2) |
| `gerente` (GM) | Un hotel | Sí (Daily Flash, tarifas ±10-15%, revenue) | No |
| `recepcion` | Un hotel | Aprobación de 1er nivel (check-in/out, cargos) | No |
| `housekeeping` | Un hotel | No | No |
| `mantenimiento` | Un hotel | No | No |
| `ayb` (alimentos y bebidas) | Un hotel | Cargos a folio (con límite) | No |
| `revenue` | Un hotel (o grupo) | Propuestas de tarifa (nunca autopilot sin gate, BP-054) | No |
| `contabilidad` | Un hotel (o grupo) | Conciliación, CFDI (nunca presentación SAT sin aprobación humana, GOB-014/BP-070) | No |
| `huesped` | Su propia reserva/folio únicamente | No | No |

**RLS por sesión.** Cada request abre una transacción que ejecuta `set local role authenticated` + `select set_config('request.jwt.claim.sub', <user_id>, true)` + `set_config('app.tenant_id', <org_id>, true)` + `set_config('app.hotel_id', <hotel_id>, true)` (este último solo cuando el request opera sobre un hotel concreto) antes de correr la query de negocio — mismo patrón verificado en el experimento de PGlite (07-stack-viabilidad.md Experimento 1) y en Restaurantes, ajustado para que `tenant_id` sea siempre el `org_id` (ver "Tenant y organización" arriba).

**Idempotencia y advisory locks.** Toda mutación con efecto externo (crear reserva, cobrar, postear cargo) exige un `idempotency_key` de cliente; constraint `UNIQUE (tenant_id, idempotency_key)` + `INSERT … ON CONFLICT DO UPDATE/NOTHING`, exactamente como se verificó en `create_reservation_idempotent()` del experimento de PGlite. La disponibilidad/overbooking se protege con `pg_advisory_xact_lock` sobre `(hotel_id, room_type_id, fecha)` antes de decrementar inventario — verificado como mecanismo real (no solo `ON CONFLICT`) únicamente contra `embedded-postgres` (ADR-003).

**Outbox + reintentos con backoff.** Toda escritura hacia un conector externo (PMS, CFDI, WhatsApp) pasa por una tabla `outbox` que un worker drena con reintento exponencial y `Retry-After` respetado (H15-019, H15-016); mismo principio que el mutex de Likida: un error transitorio de la red **nunca** se trata como éxito ni como "no hay nada que reintentar" (fail-cerrado, `docs/referencia/06-backoffice-agentes-likida.md` §2.2).

**Límites de tasa.** Rate limiting por `(número, tenant, país)` en el borde de la API (GOB-043) y por conector en el outbox (H15-019).

**Evidencia.** `docs/referencia/07-stack-viabilidad.md` Experimentos 1, 2 y 4; `docs/referencia/03-investigacion-H12-H21.md` H15-007/008/016/019/020, §3.3; `docs/referencia/04-gobierno-y-protocolo.md` GOB-010, GOB-013, GOB-038, GOB-042, GOB-043; `docs/referencia/06-backoffice-agentes-likida.md` §2.2-2.3, §3.3.

**Consecuencias.** GoTrue/PostgREST (Auth y API HTTP reales de Supabase) no se reproducen; el JWT propio reproduce el *modelo de permisos*, no el contrato HTTP exacto de Supabase — declarado como brecha en ADR-003.

**Prueba que lo verifica.** Prueba adversarial de tenant (RLS): usuario de la `org A` con JWT válido intenta leer/escribir una reserva de un hotel bajo la `org B` → rechazado por RLS (403/0 filas); prueba adversarial de hotel (scope secundario dentro del mismo `org`): usuario con rol solo en `hotel A` (misma `org` que `hotel B`) intenta leer/escribir una reserva de `hotel B` → rechazado por el scope `hotel_id`, aunque el `org_id` coincida; prueba de concurrencia con `embedded-postgres`: dos requests simultáneos reservando la última habitación disponible → exactamente una tiene éxito, la otra recibe "sin disponibilidad", sin overbooking; prueba de idempotencia: mismo `idempotency_key` enviado dos veces → una sola reserva creada; prueba de outbox: conector simulado que falla dos veces y responde al tercer intento → evento se marca entregado una sola vez.

---

## ADR-005 — Modelo de dominio hotelero mínimo enterprise

**Contexto.** BP-011 fija que el PMS (cuando existe) es la fuente de verdad de inventario/tarifas/reservas/folios y que el sistema propio es la fuente de verdad de conversaciones/tareas/energía/cumplimiento/analítica; H15-016 fija el pipeline canónico; H16 fija folio/CFDI/night audit; H19 fija retención y bóveda de identidad; GOB-026/037 fijan `audit_log` encadenado y `ROIEvent`.

**Decisión.** Entidades mínimas (todas con `tenant_id`, `created_at`, `updated_at`, RLS, prueba de aislamiento negativa — GOB-038):

- `hotel` (org opcional arriba), `room_type`, `room` (estado: `disponible|ocupada|sucia|fuera_de_servicio|mantenimiento`).
- `rate` (tarifa por `room_type`×fecha), `availability` (inventario por noche, decrementado bajo advisory lock).
- `reservation` — estados: `cotizada → confirmada → check_in → en_estancia → check_out → cerrada`, laterales `cancelada`, `no_show`; cada transición es un evento append-only, nunca un `UPDATE` destructivo del estado anterior.
- `guest` — datos mínimos (BP-026/H19-004: copia de identificación con TTL ≤30 días, purga automática, bóveda aislada — GOB-044).
- `folio`, `charge`, `payment` (incluye VCC como máquina de estados con `expiresAt`, H15-020); dinero siempre `numeric(12,2)`, nunca `float` (GOB-013).
- `housekeeping_task`, `maintenance_ticket` (origen: camarista/recepción/huésped/sensor/reseña, con prioridad/SLA — BP-077).
- `conversation`, `message` (canal WhatsApp/voz/email/web, un solo "cerebro" — BP-020).
- `agent_task` + `approval` (`needs_approval` obligatorio en efectos externos/dinero — ver ADR-006).
- `audit_log` — append-only, hash encadenado al registro anterior (mismo patrón que GOB-026 exige para licitaciones, portado aquí para toda acción con impacto económico/legal sobre el huésped, per H19-011).
- `integration_event` (RawEvent inmutable con `sha256` y procedencia, H15-016) y `outbox` (ver ADR-004).
- `roi_event` — `monto_verificado`, `monto_estimado`, `metodo_contrafactual`, `confianza` (H17-001, GOB-037).

**Evidencia.** `docs/referencia/03-investigacion-H12-H21.md` BP-011, H15-016, H15-020, H16-003/007, H17-001; `docs/referencia/04-gobierno-y-protocolo.md` GOB-013, GOB-026, GOB-037, GOB-038, GOB-044; `docs/referencia/01-blueprint-y-decision-llm.md` BP-020, BP-026, BP-077.

**Consecuencias.** El modelo se diseña para que `pms_mirror` (cuando exista un conector PMS real) sea estrictamente de solo lectura desde la lógica de negocio (BP-011, GOB-016) — ninguna tabla de negocio escribe ahí.

**Prueba que lo verifica.** Test de arquitectura (grep/análisis estático) que confirma que ningún módulo fuera del conector PMS escribe en `pms_mirror`; test de esquema que confirma columnas monetarias `numeric(12,2)`; test que confirma que `audit_log` es append-only con hash encadenado verificable.

---

## ADR-006 — Agentes y herramientas: patrón Likida + `needs_approval` + runtime por rol de DECISIONLLM

**Contexto.** `docs/referencia/06-backoffice-agentes-likida.md` documenta patrones verificados en código real de producción (no diseño teórico): tools con `properties: {}` que nunca reciben datos identificadores del modelo (tenant/hotel/huésped se inyectan desde `ToolContext` server-side, cerrando la inyección de prompt de forma estructural, §2.5); loop-guard que corta *antes* de gastar la última ronda (§2.6); fallback cross-provider limitado a la llamada de completado, nunca reejecuta una mutación (§2.6); presupuesto de tiempo compartido entre etapas con `acotada()` como techo duro de toda consulta (§2.3). GOB-026/032/036 exigen `needs_approval` obligatorio en toda herramienta con efecto externo, prohibición de `always_approve` en precio/emisión, y que el LLM elija entre opciones válidas pero nunca calcule precio/tarifa/impuesto/disponibilidad/horario. `docs/referencia/01-blueprint-y-decision-llm.md` §3 fija el runtime por rol: Sonnet 5 (`effort: low` voz, `medium` texto) para conversación/reservas; Haiku 4.5 para enrutamiento de idioma/intención y clasificación de bajo costo; Opus 5 en modo Batch para GM Copilot/Revenue/cierre CFO nocturno.

**Opciones.**
1. Copiar Inngest tal cual (H20 lo fija) para orquestar jobs/`waitForEvent` de aprobación humana.
2. Construir una cola de aprobación/jobs propia sobre la misma Postgres (tabla `agent_task`/`approval` + worker), inspirada en la semántica de Inngest (`waitForEvent`), sin depender de una cuenta o servicio externo.

**Decisión sobre orquestación de aprobaciones.** Opción 2 por ahora, marcada explícitamente como **desvío documentado** (ver tabla de desvíos): Inngest en producción requiere una cuenta Inngest Cloud o un self-host; no se verificó en esta sesión que su modo de desarrollo local corra sin cuenta en este entorno (no hay evidencia de haberlo probado — no se inventa el resultado), y no se gastan créditos ni se abre una cuenta sin autorización. Se construye la cola de aprobación (`agent_task` en estado `pendiente_aprobacion`, resuelta por un humano vía API/WhatsApp/web) sobre la misma Postgres, con la misma semántica de "esperar evento humano" que BP-043 exige, detrás de una interfaz que permita sustituir el worker propio por Inngest más adelante sin tocar los agentes.

**Decisión sobre `needs_approval`.** Toda herramienta con efecto externo o económico (cobrar, reembolsar, cambiar tarifa, publicar reseña, enviar mensaje proactivo, mover housekeeping a "aprobado") se define con `needs_approval: true` de forma no opcional en el esquema de la tool; `always_approve` queda prohibido a nivel de tipo para las tools de precio/emisión/pago (mismo patrón GOB-026, portado de licitaciones a hoteles). Cada aprobación registra en `audit_log` el texto exacto que vio el aprobador, con hash encadenado.

**Decisión sobre tools.** Todas las tools de dominio (crear ticket de housekeeping, cotizar tarifa, cerrar folio) declaran `parameters.properties` sin campos identificadores de tenant/hotel/huésped — esos valores vienen del `ToolContext` resuelto en el servidor a partir del JWT de sesión (ADR-004), nunca del argumento generado por el modelo.

**Decisión sobre aislamiento de contexto entre tenants (REQ-AGT-022, GOB-025).** El `ToolContext`/constructor de prompt del agente arma el contexto de cada invocación exclusivamente con datos del hotel/tenant en curso y hechos públicos (catálogo de precios, políticas publicadas); prohibido incluir ejemplos few-shot o historial de otro tenant en el prompt de sistema o en los mensajes de contexto. Cualquier memoria/vector store usado para RAG de FAQ/políticas (REQ-AGT-014) es efímero y particionado por `(tenant_id, conversación)`, expirando/destruyéndose al cerrar la conversación — mismo principio de aislamiento que GOB-025 exige en licitaciones, portado aquí porque la fuga de contexto entre hoteles es, según `docs/auditoria/RUBROS.md`, el eje de seguridad propio de este producto. Este control es distinto y complementario al aislamiento por RLS a nivel de base de datos (REQ-TEN-001/GOB-038, ADR-003/004): uno protege la fila en Postgres, el otro protege lo que efectivamente entra al prompt del LLM.

**Decisión sobre runtime por rol.** Un único mapa `ModelRole → slug` configurable por variable de entorno (mismo patrón `models.ts` de Likida, §2.7: cada default con su justificación y fuente en comentario, override por `ENV_KEY`), con `ROLE_PARAMS` fijando `temperature: 0` donde hay dinero/extracción determinista. El proveedor real (Anthropic) se activa detrás de `ANTHROPIC_API_KEY`; sin esa variable, el sistema entra en **modo "sin credenciales" honesto**: las rutas que requieren LLM devuelven un estado explícito ("agente de IA no configurado en este entorno") en vez de simular una respuesta — nunca se fabrica un output de modelo para aparentar que la integración funciona (restricción explícita del encargo).

**Evidencia.** `docs/referencia/06-backoffice-agentes-likida.md` §2.2, §2.3, §2.5, §2.6, §2.7; `docs/referencia/04-gobierno-y-protocolo.md` GOB-025, GOB-026, GOB-032, GOB-036, GOB-037; `docs/referencia/01-blueprint-y-decision-llm.md` §3 puntos 1-3; `docs/referencia/03-investigacion-H12-H21.md` BP-043/054/070 (vía tabla de requisitos H12-H21, sección 2.5-2.11 del documento fuente `03-investigacion-H12-H21.md`, en realidad citada desde `01-blueprint-y-decision-llm.md` BP-043/BP-054/BP-070 — mismo repositorio de referencia).

**Requisitos que cubre.** REQ-AGT-001, REQ-AGT-002, REQ-AGT-004, REQ-AGT-006, REQ-AGT-022 (P0), REQ-AGT-014.

**Consecuencias.** El motor de precios/impuestos/disponibilidad es siempre un servicio tipado determinista, nunca una llamada a LLM (GOB-013/032) — el LLM solo *propone* y *explica* en ≤40 palabras (BP-003).

**Prueba que lo verifica.** Test unitario: ninguna tool de precio/tarifa/impuesto/disponibilidad se resuelve por generación libre del LLM (se valida contra el motor determinista); test de configuración: ninguna tool de dinero/emisión tiene `always_approve=true`; test funcional: con `ANTHROPIC_API_KEY` ausente, la ruta de agente conversacional responde con el estado honesto de "no configurado", no con texto generado; test de loop-guard: una conversación que agota `maxRounds` sin resolver corta antes de ejecutar una mutación adicional; test de aislamiento de contexto (REQ-AGT-022): dado un tenant A, ningún fragmento del prompt construido contiene datos de otro tenant.

---

## ADR-007 — Integraciones: puertos/adaptadores con contrato y prueba de contrato; pendientes por credenciales

**Contexto.** H15-016 fija el patrón obligatorio (Ingress → RawEvent → `Adapter.normalize` → command bus → Reducer → Outbox → stream) y GOB-027/059 exigen registro único de conectores (`fetchList/fetchDetail/fetchDocuments` con salida validada por esquema, prohibido `if provider === X` fuera del registro). El catálogo maestro de integraciones (H15 tabla, `docs/referencia/03-investigacion-H12-H21.md` §5) lista PMS, pagos, WhatsApp, voz/PBX, CFDI, contabilidad, clima/vuelos, cerraduras, con su orden de construcción en 5 fases.

**Decisión.** Cada integración se implementa como **puerto** (interfaz TypeScript + esquema Zod versionado del contrato) + **adaptador real** contra el proveedor + **prueba de contrato** (fixture grabado del proveedor, sin llamar a la red en CI) — nunca un mock que sustituya la lógica de negocio. Estado por integración en esta fase:

| Integración | Puerto/contrato | Adaptador real | Estado |
|---|---|---|---|
| PMS (Cloudbeds primero, H15-001) | `PmsPort` (reservas, cargos, tarifas, housekeeping) | Requiere credenciales OAuth del hotel | **[PENDIENTE DE CREDENCIALES]** |
| WhatsApp Cloud API (H15-012) | `MessagingPort` (enviar/recibir, Flows) | Requiere Meta Business + Tech Provider | **[PENDIENTE DE CREDENCIALES]** |
| Pagos (Stripe MX/Conekta, H15-007) | `PaymentProviderPort` (cobro, pre-auth, VCC) | Requiere cuenta del proveedor | **[PENDIENTE DE CREDENCIALES]** |
| CFDI hospedaje (PAC, H16-007) | `CfdiPort` (timbrado idempotente, `ImpuestosLocales`) | Requiere PAC contratado + CSD del hotel | **[PENDIENTE DE CREDENCIALES]** |
| Voz (LiveKit+Deepgram+TTS, BP-040) | `VoicePort` | Requiere cuentas Telnyx/LiveKit/Deepgram/TTS | **[PENDIENTE DE CREDENCIALES]** |
| Correo/fallback (BP-012) | `MessagingPort` (mismo puerto, otro canal) | SMTP propio o proveedor | **[PENDIENTE DE CREDENCIALES]** (más barato de habilitar primero si el usuario provee SMTP) |

**Evidencia.** `docs/referencia/03-investigacion-H12-H21.md` §5 (tabla maestra de integraciones), H15-016, H15-017 (contratos versionados, feature flags por propiedad); `docs/referencia/04-gobierno-y-protocolo.md` GOB-027, GOB-059.

**Consecuencias.** El código de cada puerto y su adaptador se construye completo (incluyendo manejo de `Retry-After`, HMAC de webhooks — GOB-042 — y rate limiting) aunque no pueda ejecutarse contra el proveedor real sin credenciales; el criterio "10 de 10" del encargo se satisface para estos módulos con evidencia de la prueba de contrato contra fixture, no con una ejecución real, y así se declara.

**Prueba que lo verifica.** Prueba de contrato por integración: dado un fixture HAR/JSON grabado (o construido a partir de la documentación pública del proveedor, señalado como tal), el adaptador produce el `RawEvent`/comando esperado validado contra el esquema Zod; prueba de idempotencia de webhook (HMAC inválido rechazado, `source.event_id` deduplicado, GOB-042); ningún test de este grupo se reporta como "integración completa" en `docs/PROGRESO.md`.

---

## ADR-008 — Observabilidad y operación

**Contexto.** El encargo exige observabilidad, documentación operativa y migraciones reversibles. GOB-011 prohíbe editar migraciones ya mergeadas (patrón expand-only). H16-021 exige alertas configurables con umbral y destinatario por tipo.

**Decisión.**
- **Logs estructurados** (JSON) con `tenant_id`/`hotel_id`, `reservation_id`, `request_id` y `run_id` de agente en cada línea, redactando PII antes de persistir (mismo principio que GOB-035, adaptado de voz/WhatsApp a todo el sistema).
- **Métricas** mínimas: latencia por endpoint, tasa de error por conector, presupuesto de LLM consumido por corrida (mismo patrón de contabilidad de costo por modelo real de Likida, §2.6).
- **Health checks**: `/health` (proceso) y `/health/db` (conexión Postgres + migraciones aplicadas).
- **Runbooks**: al menos el de "brecha de seguridad" exigido por H19-010 y el de "caída de conector externo" (outbox drena solo, alerta si supera N reintentos).
- **Backups**: `pg_dump` programado contra el Postgres real (aplica a `embedded-postgres` en desarrollo y a Supabase remoto en producción); no se implementa backup de PGlite (es efímero, solo pruebas).
- **Migraciones reversibles**: expand-only (GOB-011); ningún `DROP` de columna con datos sin backfill previo y fase "contract" aprobada.

**Evidencia.** `docs/referencia/04-gobierno-y-protocolo.md` GOB-011, GOB-035; `docs/referencia/03-investigacion-H12-H21.md` H16-021, H19-010.

**Prueba que lo verifica.** Test que rechaza un `ALTER`/edición de una migración ya presente en el historial; test de `/health` en verde con Postgres caído devolviendo 503, no 200; prueba de que ninguna traza persistida contiene PII sin redactar (dataset de prueba con datos sintéticos).

---

## ADR-009 — Pruebas y calidad

**Contexto.** El encargo exige unit, integración DB, E2E, pruebas adversariales de aislamiento/permisos, capturas de render real comparadas con Restaurantes, auditoría de dependencias, CI. `07-stack-viabilidad.md` confirma en esta máquina: Playwright puede conducir el Chrome del sistema sin descargar binarios propios (`channel: 'chrome'`, prueba real pasó); Chrome headless produce capturas PNG reales; `gh` está autenticado (`javiercamarapp`).

**Decisión.**
- **Unit**: Vitest, sobre PGlite para lógica con RLS (ADR-003).
- **Integración DB**: Vitest + `embedded-postgres` para concurrencia/idempotencia/advisory locks reales (ADR-003/004).
- **E2E**: Playwright con `channel: 'chrome'` apuntando a `/Applications/Google Chrome.app/...` (verificado, no se descargan binarios de Playwright), recorridos esenciales: login → crear reserva → check-in → cargo a folio → check-out.
- **Adversariales de aislamiento/permisos**: batería que intenta cruzar tenant (usuario de la `org A` leyendo un hotel de la `org B`), cruzar hotel dentro del mismo `org` (usuario con rol solo en `hotel A` leyendo `hotel B` de la misma `org`), escalar rol (huésped intentando ver back office), reenviar webhook con firma inválida, doble-cobrar con el mismo `idempotency_key` — mismo espíritu que la skill `auditoria-semanal` de Likida (06 §5.3: "un ataque que rompe = bug encontrado con su prueba ya lista").
- **Capturas de render real vs. Restaurantes**: Chrome headless (`--headless=new --screenshot`, confirmado funcionando en esta máquina) sobre componentes reales (nunca una copia — mismo principio del patrón `zzz-preview-*` de Likida, 06 §5.2: "una copia verifica la copia") comparando sidebar/tokens/tipografía contra capturas equivalentes de `atiende-restaurantes`.
- **Auditoría de dependencias**: `npm audit --audit-level=high` bloqueante solo para dependencias de runtime, no de tooling (mismo criterio que el CI de Likida, 06 §5.1, evita bloquear por vulnerabilidades de `vitest`/`vite`/`esbuild` en devDependencies).
- **CI**: GitHub Actions (repo ya tiene `gh` autenticado), orden de puertas que falla rápido: `npm ci` → `npm audit` → `typecheck`+`lint` → tests offline → `test:coverage` → `build` → smoke Playwright contra el build real, mismo orden que `docs/referencia/06-backoffice-agentes-likida.md` §5.1 documenta como probado en producción.

**Evidencia.** `docs/referencia/07-stack-viabilidad.md` Experimento 4 y 5; `docs/referencia/06-backoffice-agentes-likida.md` §5.1-5.3.

**Prueba que lo verifica.** El propio pipeline de CI en verde es la prueba; adicionalmente, cada prueba adversarial documenta su intento roto/no-roto (nunca se descarta un ataque que sí rompe algo).

---

## ADR-010 — Bucle de construcción y auditoría (Likida adaptado a sesión Claude Code)

**Contexto.** `docs/referencia/06-backoffice-agentes-likida.md` §4 documenta el mecanismo real de auditoría desatendida de Likida: 6 fases (anclaje, 12 auditores en paralelo con contexto fresco, verificación adversarial, tablero, arreglo de críticos/altos, recalificación y cierre), 12 rubros con anclas de calificación 0-10, y un análisis explícito (§4.5) de qué es portable *dentro de una sesión de Claude Code* (todo el contenido: fases, rubros, prompt del auditor, criterio de retener/revertir, subagentes en paralelo) frente a qué requiere `launchd`/cron de sistema operativo (solo el disparo sin sesión activa). `docs/operacion-bucle.md` ya registra el mecanismo de continuidad de esta sesión (`/loop` dinámico + `CronCreate f24bfd35` de respaldo). `docs/referencia/04-gobierno-y-protocolo.md` GOB-009 exige auditoría periódica cada 8 tareas cerradas.

**Decisión.** Se adopta el contenido completo de la skill `auditoria-diaria` de Likida, adaptado a 12 rubros hoteleros, ejecutado dentro de esta sesión de Claude Code vía subagentes `model=sonnet` en paralelo (una sola llamada, múltiples invocaciones — mismo patrón que exige el encargo de "auditores adversariales con contexto independiente"):

1. **Frontend** (05 → paridad de tokens/mobile/accesibilidad contra Restaurantes).
2. **Backend y API** (Hono, JWT, RLS por sesión, idempotencia).
3. **Sistema agéntico y orquestación** (loop-guard, presupuesto, `needs_approval`).
4. **Tool calling** (`properties: {}`, `ToolContext` server-side).
5. **Seguridad** (secretos, HMAC, PII, bóveda de identidad).
6. **Cumplimiento fiscal** (ISH, CFDI hospedaje, DSA — H16).
7. **Cumplimiento legal** (LFPDPPP, ARCO, retención de identificación — H19).
8. **Arquitectura y mantenibilidad** (registro único de conectores, expand-only).
9. **Pruebas** (adversariales reales, no decorativas — "si la prueba seguiría verde sin el arreglo, es decoración", 06 §4.4).
10. **Operabilidad y DX** (health, logs, runbooks).
11. **Rendimiento y costo** (presupuesto de LLM, costo por modelo real).
12. **Modelo de datos y esquema** (RLS, `tenant_id`, migraciones reversibles).

Cada ronda produce `docs/auditoria-N/` (un archivo por rubro + `00-SINTESIS.md` + tablero HTML capturado con Chrome headless), con las tres razones válidas para mover una nota (se atacó y subió / deuda que cobró factura / mirada más profunda) y el criterio retener/revertir de Likida (§4.4: una prueba que pasa con y sin el arreglo no probó nada).

**Evidencia.** `docs/referencia/06-backoffice-agentes-likida.md` §4 completo; `docs/referencia/04-gobierno-y-protocolo.md` GOB-009; `docs/operacion-bucle.md`.

**Consecuencias.** Lo que Likida resuelve con `launchd` (disparo sin sesión activa) no se replica en esta fase — el bucle depende de que la sesión de Claude Code (o su `CronCreate`/`ScheduleWakeup`) esté viva, tal como ya está documentado y aceptado en `docs/operacion-bucle.md`.

**Prueba que lo verifica.** Existencia de los 12 archivos + síntesis + tablero (`.html` y `.png`) por ronda; cada hallazgo crítico/alto en uno de tres estados verificables (commiteado con prueba / pendiente con razón / descartado con razón); `npm run test`/`typecheck`/`lint`/`build` en verde sobre el árbol final de cada ronda.

---

## Estructura de carpetas propuesta

```
atiende-hoteles-staging/
├── package.json              # workspaces: apps/*, packages/*
├── turbo.json
├── apps/
│   ├── web/                  # Vite+React+TS panel (ADR-002)
│   └── api/                  # Hono backend (ADR-004)
├── packages/
│   ├── domain-hotel/         # tipos, esquemas Zod, motores deterministas (precio/impuesto)
│   ├── db/                   # migraciones .sql versionadas, runner, seeds, políticas RLS
│   ├── agent-core/           # tool registry, ToolContext, loop-guard, presupuesto, needs_approval
│   ├── mcp-servers/
│   │   ├── pms/               # puerto + adaptador Cloudbeds (ADR-007)
│   │   ├── whatsapp/          # puerto + adaptador Meta Cloud API (ADR-007)
│   │   ├── payments/          # puerto + adaptador Stripe MX/Conekta (ADR-007)
│   │   └── cfdi/               # puerto + adaptador PAC (ADR-007)
│   ├── ui/                    # primitivos shadcn + tokens + AtiendeLogo + ThemeSelector (ADR-002)
│   └── config/                 # tsconfig/eslint compartidos
├── tests/
│   ├── unit/                  # Vitest + PGlite
│   ├── integration/           # Vitest + embedded-postgres
│   ├── e2e/                   # Playwright + Chrome del sistema
│   └── adversarial/            # aislamiento de tenant, permisos, idempotencia
├── .github/workflows/ci.yml
└── docs/
    ├── REQUISITOS.md, ACEPTACION.md, PROGRESO.md, BLOQUEOS.md, ARQUITECTURA.md (este archivo)
    ├── auditoria-N/
    └── referencia/
```

## Hitos de implementación (H1..Hn) y requisitos P0 que cubre cada uno

| Hito | Contenido | Requisitos P0/gobierno cubiertos |
|---|---|---|
| **H1** | Scaffold monorepo (ADR-001) + esquema core (`hotel/room_type/room/rate/availability/reservation/guest`) + RLS + migraciones versionadas + suite PGlite/`embedded-postgres` | GOB-010, GOB-038, H15-016 (fundamento del pipeline), BP-011 (frontera de escritura) |
| **H2** | Backend Hono + JWT propio + matriz de roles + `set_config` de claims + idempotencia + advisory locks + outbox | GOB-013, GOB-042, H15-007, H15-020, H14-... (no aplica) |
| **H3** | Frontend: identidad portada, sidebar hotelero, mobile real (bottom-nav), estados vacío/carga/error, accesibilidad (axe) | Hallazgos 05 §2.5/§2.8 cerrados; criterios de experiencia móvil/accesibilidad del encargo |
| **H4** | Módulo de reservas/disponibilidad (calendario, tipos de habitación, tarifas, transiciones de estado) + pruebas de concurrencia real | H14-... no aplica; H15-001 (adaptador PMS en modo puerto), disponibilidad P0, BP-002/044 |
| **H5** | Folio/cargos/pagos + contrato CFDI hospedaje (pendiente credenciales) + night audit propio | H16-003, H16-007 (contrato), BP-008/009/072 |
| **H6** | Housekeeping/mantenimiento + contrato WhatsApp (pendiente credenciales) + `agent-core` con `needs_approval` | BP-005/006/073-078, H15-012 (contrato), GOB-026 |
| **H7** | Runtime de agentes por rol (Sonnet/Haiku/Opus vía env) + `audit_log` encadenado + `roi_event` | GOB-014, GOB-025, GOB-032, GOB-036, GOB-037, H17-001 — REQ-AGT-003, REQ-AGT-004, REQ-AGT-006, REQ-AGT-022, REQ-REV-018 |
| **H8** | Observabilidad (logs/métricas/health/runbooks/backups) + CI GitHub Actions + `npm audit` + Playwright E2E + adversariales | ADR-008/009 completos; GOB-011 |
| **H9** | Adaptadores reales de integración (PMS/WhatsApp/pagos/CFDI/voz) en cuanto existan credenciales — hasta entonces solo contrato+fixture | H15 catálogo completo (§5), marcado **[PENDIENTE DE CREDENCIALES]** |
| **H10** | Bucle de auditoría hotelero (12 rubros, `docs/auditoria-N/`) cada 8 tareas cerradas | GOB-009, ADR-010 |

## Tabla de desvíos respecto a H20, con justificación

| # | Decisión de H20 | Desvío en esta arquitectura | Justificación (evidencia) |
|---|---|---|---|
| 1 | pnpm + Turborepo (§3.1 punto 9) | npm workspaces + Turborepo (turbo es agnóstico del gestor) | `pnpm` no instalado; no se instalan paquetes de sistema sin autorización (B-002, `07-stack-viabilidad.md`) |
| 2 | Un solo núcleo físico compartido con `atiende-restaurantes` (§3.1 punto 1) | Repo nuevo y separado, misma topología de paquetes, fusión física diferida | Encargo prohíbe modificar `atiende-restaurantes` (instrucción del usuario) |
| 3 | Supabase multi-tenant (Postgres+RLS+GoTrue+PostgREST) como plataforma | Ninguno en producción: Supabase sigue siendo el destino (H20). Solo para el **entorno local** de desarrollo/pruebas en esta máquina: Postgres local (PGlite para unit, `embedded-postgres` para integración) + JWT propio con el mismo contrato de claims RLS, mientras no haya Docker/proyecto Supabase disponible | Docker/Supabase CLI no funcionan localmente para `start`/`db diff`/`gen types` (verificado, `07-stack-viabilidad.md` Experimento 3); esquema queda compatible para migrar a Supabase remoto; un cambio real de proveedor de BD de producción requeriría aprobación del fundador (REQ-GOB-012/REQ-AGT-011, ver `docs/BLOQUEOS.md` D-001) |
| 4 | Deno (Supabase Edge Functions) como runtime de backend de Restaurantes | Node/TS con Hono (runtime-portable a Deno) | `deno` no instalado; Hono elegido en parte para minimizar el costo de una futura migración a Edge Functions |
| 5 | Inngest para jobs/`waitForEvent` de aprobación | Cola de aprobación propia sobre Postgres con semántica equivalente, adaptador-sustituible | No se verificó en esta sesión que Inngest corra sin cuenta/credenciales en este entorno; no se abre cuenta ni se gasta sin autorización |
| 6 | Langfuse para trazabilidad de LLM | Logs estructurados + tabla de trazas propia (tenant/reservation-tagged) | Requiere cuenta/credenciales externas no disponibles en esta fase |
| 7 | PowerSync para sincronización offline-first del edge | No implementado en esta fase; queda como integración pendiente completa | No hay hardware edge (mini-PC/Home Assistant) presente en este entorno de desarrollo |
| 8 | PMS/WhatsApp/pagos/CFDI/voz reales operando en producción | Puerto + adaptador + prueba de contrato, sin ejecución contra el proveedor real | Todas exigen credenciales que el encargo prohíbe fabricar o simular como si estuvieran completas |

---

## Resumen (≤12 líneas)

Stack decidido: monorepo **npm workspaces + Turborepo**; frontend **Vite+React+TS+shadcn+Tailwind** portando identidad/tokens/primitivos de `atiende-restaurantes` con navegación hotelera y mobile real (bottom-nav) que Restaurantes no tiene; backend **Hono + JWT propio (`jose`)** con RLS por sesión (`set_config` de claims), tenant=hotel, matriz de 9 roles, idempotencia y `pg_advisory_xact_lock`; persistencia de **producción: Supabase** (H20, sin decisión de cambio — ver ADR-003); **entorno local de desarrollo/pruebas**: PGlite para RLS/unitarias rápidas y `embedded-postgres` 18.4 (Postgres real, concurrencia verificada 302 ms) para integración/contención, con esquema compatible con Supabase; agentes con patrón Likida (tools sin datos del modelo, loop-guard, presupuesto, `needs_approval` obligatorio, aislamiento de contexto por tenant REQ-AGT-022) y runtime Sonnet/Haiku/Opus por rol vía variable de entorno, con modo "sin credenciales" honesto; integraciones PMS/WhatsApp/pagos/CFDI/voz/energía-IoT/cerraduras como puerto+adaptador+contrato, **pendientes de credenciales/hardware** sin marcarse completas. Tres desvíos principales respecto a H20: (1) npm workspaces en vez de pnpm por B-002; (2) entorno **local** con Postgres propio (PGlite+`embedded-postgres`) en vez de Supabase gestionado, porque Docker/Supabase CLI no funcionan en esta máquina — producción sigue apuntando a Supabase, ver `docs/BLOQUEOS.md` D-001; (3) cola de aprobación propia en vez de Inngest, por no haberse verificado su ejecución sin credenciales en este entorno.
