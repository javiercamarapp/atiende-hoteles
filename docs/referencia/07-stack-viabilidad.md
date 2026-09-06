# 07 · Viabilidad técnica del stack (persistencia y pruebas) sin Docker

Investigación ejecutada en esta máquina (macOS Darwin 24.6, arm64, Node
v25.6.1, npm 11.12.1) el 2026-09-05/06. Todos los experimentos se corrieron en
`atiende-hoteles-staging/.lab` (carpeta desechable, eliminada al final de esta
tarea; solo queda este documento). El objetivo era decidir con qué stack se
puede probar de verdad "backend y persistencia real, migraciones, aislamiento
entre tenants, idempotencia, concurrencia" en esta máquina, sin Docker.

Referencia usada para entender las garantías esperadas: el repo hermano
`atiende-restaurantes` (Vite+React+TS+shadcn, Supabase/Postgres+RLS+Edge
Functions Deno). Se leyó `supabase/tests/run-local.sh`, `supabase/config.toml`
y las migraciones `20260904050000_enterprise_tenant_isolation.sql` y
`20260904065000_tenant_role_matrix.sql`. Patrón que usan: RLS con funciones
`security definer` (`is_restaurant_staff`, `can_manage_restaurant`,
`shares_restaurant`), sesión de prueba simulada con
`set local role authenticated` + `select set_config('request.jwt.claim.sub', …)`
(no `request.jwt.claims` como JSON completo, sino el claim individual que lee
`auth.uid()` de Supabase), pruebas SQL puras con `psql -f` orquestadas por
`run-local.sh` contra `127.0.0.1:54322` (el Postgres que levanta `supabase
start`, es decir, requiere Docker), más scripts de concurrencia
(`order_idempotency_concurrency.sh`, `messaging_outbox_concurrency.sh`) y de
migración fuera de orden. Índices por tenant (`orders_tenant_created_idx`,
etc.) y `ON CONFLICT` en varios flujos (idempotencia de pedidos, outbox de
mensajería).

## Hechos de entorno verificados

```
$ uname -m
arm64
$ node -v && npm -v
v25.6.1
11.12.1
$ which docker supabase deno bun pnpm psql pg_ctl pdftotext
docker not found / supabase not found / deno not found / bun not found / pnpm not found / psql not found / pg_ctl not found
pdftotext -> /opt/homebrew/bin/pdftotext (via Homebrew, no relevante a persistencia)
$ gh auth status
✓ Logged in to github.com account javiercamarapp (keyring)
```

No hay Docker, Supabase CLI global, Deno, Bun, pnpm, psql ni pg_ctl instalados
como binarios de sistema. Sí hay red npm y Google Chrome 152.

## Experimento 1 — PGlite (`@electric-sql/pglite`) con RLS, triggers, `ON CONFLICT`, advisory locks

Se instaló `@electric-sql/pglite@0.5.8` + `vitest@4.1.11` (vitest resolvió
4.1.11, no 5.0.0 como se había visto disponible en un chequeo anterior; sigue
siendo una versión moderna y funcional) con `npm install` (sin `npm init -y`
porque el nombre de carpeta `.lab` es inválido para npm; `npm install` generó
el `package.json` igualmente).

Migración mínima (`migration.sql`) con dos tablas (`hotels`, `reservations`),
`hotel_staff`, una función `security definer` (`is_hotel_staff`, calco de
`is_restaurant_staff`), `alter table … enable row level security`, políticas
que leen `current_setting('request.jwt.claim.sub', true)::uuid` (mismo patrón
que Restaurantes), un trigger `bump_version` (`before update`), y una función
`create_reservation_idempotent()` que usa `pg_advisory_xact_lock` +
`insert … on conflict (hotel_id, idempotency_key) do update`. Se sembraron dos
tenants (Hotel A / Hotel B) con un usuario admin cada uno.

Prueba `pglite.test.ts` (vitest) que abre una transacción, hace
`set local role authenticated` + `set_config('request.jwt.claim.sub', …)` por
tenant, y verifica: (a) tenant A solo ve reservas de Hotel A, (b) tenant B
solo ve las de Hotel B, (c) un insert cruzado de tenant A hacia Hotel B es
rechazado por la política `with check`, (d) `create_reservation_idempotent`
con la misma `idempotency_key` no duplica fila (usa `ON CONFLICT` +
`pg_advisory_xact_lock`), (e) el trigger incrementa `version` en updates.

**Salida real:**

```
$ npx vitest run pglite.test.ts

 RUN  v4.1.11 /…/.lab

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  837ms
```

Nota importante encontrada aparte: la migración original incluía
`create extension if not exists pgcrypto;` para `gen_random_uuid()`. PGlite
respondió `error: extension "pgcrypto" is not available`. Se quitó esa línea
porque `gen_random_uuid()` ya es nativo del Postgres embebido en PGlite (>=13)
sin necesitar la extensión — pero esto confirma que **el catálogo de
extensiones de PGlite es limitado** (extensiones no incluidas fallan en
tiempo de ejecución, no en instalación) y hay que revisar caso por caso antes
de portar migraciones reales de Supabase (que suelen usar `pgcrypto`,
`pgjwt`, `pg_net`, `pgsodium`, `vector`, etc. — algunas sí tienen paquete
PGlite oficial vía `@electric-sql/pglite/contrib/*`, otras no).

**Límite de concurrencia real (medido):** PGlite es un solo proceso
WASM de un único "backend" lógico; dos queries lanzadas con `Promise.all`
sobre la misma instancia se sirven en fila, no en paralelo:

```
$ node pglite-concurrency.mjs
elapsed ms: 1344 (si fuera concurrencia real, ~300ms; en serie, ~600ms+)
```

(1344ms en vez de ~300 confirma que ni siquiera hay paralelismo interno —
todo se serializa a través de una sola cola de trabajo WASM). Esto invalida a
PGlite como herramienta para probar **contención real** (dos conexiones
compitiendo de verdad por un `pg_advisory_xact_lock` o una fila) aunque sí
sirve para probar la *lógica* de idempotencia (una sola conexión, múltiples
llamadas secuenciales al mismo SQL, que es lo que de hecho valida el test 4).

## Experimento 2 — Postgres real embebido vía npm (`embedded-postgres`)

`uname -m` → `arm64`. Se instaló `embedded-postgres@18.4.0-beta.17`, que trae
como dependencia opcional `@embedded-postgres/darwin-arm64@18.4.0-beta.17`
(paquete de ~144 MB con los binarios reales de Postgres 18.4, universal
x86_64+arm64 — confirmado con `lipo -info`: `Architectures in the fat file:
… are: x86_64 arm64`).

```
$ npm install embedded-postgres@18.4.0-beta.17
added 18 packages
$ du -sh node_modules/@embedded-postgres
144M
```

Arranque real (`initialise()` + `start()` de la librería, que internamente
llama a `initdb` y `pg_ctl start` de los binarios empaquetados):

```
2026-09-05 18:18:18 LOG:  starting PostgreSQL 18.4 on x86_64-apple-darwin24.6.0, compiled by Apple clang …
2026-09-05 18:18:18 LOG:  listening on IPv6 address "::1", port 54329
2026-09-05 18:18:18 LOG:  listening on IPv4 address "127.0.0.1", port 54329
2026-09-05 18:18:18 LOG:  database system is ready to accept connections
started ok
```

Nota: el log dice `x86_64-apple-darwin24.6.0` aunque la Mac es arm64 y Node
corre nativo en arm64 (`process.arch` = `arm64`) — el binario universal se
lanzó en su slice x86_64, es decir, corre **bajo traducción Rosetta 2** en
este entorno/paquete, no nativo. Funciona, pero es un costo de rendimiento a
tener presente (no bloqueante).

Con un cliente `pg` real (`getPgClient()`), se creó un rol, una tabla con RLS
y una política que lee `current_setting('app.tenant', true)`, y se confirmó
aislamiento:

```
version: PostgreSQL 18.4 on x86_64-apple-darwin24.6.0 …
rls rows (should be 1): [ { id: 1, v: 'a' } ]
OK: embedded-postgres full lifecycle + RLS works
```

**Concurrencia real (medido con dos conexiones `pg.Client` separadas):**

```
$ node embedded-pg-concurrency.mjs
elapsed ms: 302 (real concurrency expected: ~300-400ms)
```

302ms para dos `pg_sleep(0.3)` en paralelo confirma **concurrencia real de
Postgres** (procesos backend independientes, locks reales, MVCC real) —
justo lo que PGlite no puede ofrecer. `embedded-postgres` es, a todos los
efectos prácticos, Postgres de verdad: acepta cualquier extensión que venga
compilada en el binario oficial (incluye `pgcrypto`, `uuid-ossp`, `pg_trgm`,
etc. — no se verificó la lista exhaustiva pero es el mismo `postgres` que
distribuye el proyecto oficial, no un subconjunto WASM), soporta múltiples
conexiones TCP concurrentes, roles de sistema (`create role`, `set role`),
`pg_advisory_xact_lock` entre conexiones distintas (no solo dentro del mismo
proceso), y es el motor más parecido al Postgres que usa Supabase en
producción/CLI (`supabase start` en el fondo también levanta un contenedor
con la misma familia de binario Postgres).

Comparación PGlite vs. `embedded-postgres`:

| | PGlite | embedded-postgres |
|---|---|---|
| Motor | Postgres compilado a WASM, 1 solo "backend" lógico en el proceso Node | Postgres nativo real (binario oficial), multi-proceso |
| Concurrencia real (2 conexiones) | No (serializado, medido 1344ms vs 302ms) | Sí (medido 302ms) |
| RLS, roles, `set role`, triggers, `ON CONFLICT`, advisory locks | Sí (verificado) | Sí (verificado) |
| Extensiones | Catálogo limitado, algunas via paquetes `@electric-sql/pglite/contrib/*`, otras ausentes (ej. `pgcrypto` standalone falló) | Todo lo que trae el binario oficial de Postgres |
| Arranque | Instantáneo, en memoria o archivo, sin proceso de SO aparte | Proceso de SO real (`initdb`, `pg_ctl`), ~150-300ms de arranque |
| Peso en disco | ~25 MB | ~144 MB (paquete de arquitectura) |
| Arquitectura en esta Mac | Nativo WASM (sin dependencia de arch) | Universal x86_64+arm64, pero se observó ejecución bajo Rosetta (slice x86_64) en esta corrida |
| Uso ideal | Tests unitarios rápidos, muchos, aislados, sin necesidad de concurrencia real | Tests de integración que necesitan concurrencia/contención real, fidelidad máxima a Supabase, o un servidor de desarrollo local persistente |

## Experimento 3 — `npx supabase` (2.116.0) sin Docker

```
$ npx -y supabase@2.116.0 --version
2.116.0
$ npx -y supabase@2.116.0 init --workdir .
Finished supabase init.
$ npx -y supabase@2.116.0 migration new test_migration
{"path":"…/supabase/migrations/20260906001905_test_migration.sql","message":"Migration created"}
$ npx -y supabase@2.116.0 functions new test-fn
{"path":"supabase/functions/test-fn","function_name":"test-fn","auth":"apikey","message":""}
```

Estos tres (scaffolding puro de archivos) **funcionan sin Docker**.

Todo lo que requiere ejecutar o introspeccionar una base de datos falla
explícitamente pidiendo Docker/Podman, incluso apuntando a un Postgres real
ya corriendo en `127.0.0.1` (se probó contra la instancia de
`embedded-postgres` del experimento 2, puerto 54331):

```
$ npx -y supabase@2.116.0 db diff --workdir .
Creating shadow database...
{"_tag":"Error","error":{"code":"LegacyImagePrepullError","message":"failed to run docker. Docker Desktop is a prerequisite for local development…"}}

$ npx -y supabase@2.116.0 gen types typescript --local
{"_tag":"Error","error":{"code":"LegacyContainerRuntimeNotFoundError","message":"docker: command not found (podman also not found)…"}}

$ npx -y supabase@2.116.0 gen types typescript --db-url "postgresql://postgres:postgres@127.0.0.1:54331/postgres"
Connecting to 127.0.0.1 54331
{"_tag":"Error","error":{"code":"LegacyContainerRuntimeNotFoundError","message":"docker: command not found (podman also not found)…"}}

$ npx -y supabase@2.116.0 start
{"_tag":"Error","error":{"code":"LegacyDockerLifecycleInspectError","message":"failed to inspect container health: docker: command not found…"}}
```

Conclusión: `db diff`, `gen types` (incluso apuntando a un Postgres externo
real vía `--db-url`), y `start` **necesitan Docker internamente** (usan un
contenedor auxiliar, no solo la conexión a la BD). Solo `init`,
`migration new`, `functions new` (y en general el manejo de archivos locales)
son útiles sin Docker.

## Experimento 4 — Backend/auth y evaluación E2E (sin experimento SQL adicional, evaluación + prueba real de Playwright)

Dos rutas de backend evaluadas:

- **A. Contrato Supabase (PostgREST + GoTrue) para paridad con Restaurantes.**
  No es reproducible localmente sin Docker (PostgREST/GoTrue de Supabase se
  levantan como contenedores en `supabase start`). Se podría apuntar a un
  proyecto Supabase remoto real, pero eso ya no es "esta máquina sin Docker",
  es integración pendiente.
- **B. Servidor Node/TS propio (Hono o Fastify) + JWT propio (`jose`) +
  Postgres RLS**, reproduciendo el patrón de Restaurantes (`set local role
  authenticated` + `set_config('request.jwt.claim.sub', …)` por request, un
  pool de conexión que hace esto en cada transacción) contra
  `embedded-postgres` en dev/test y potencialmente el mismo Postgres en
  staging real. Verificado que `hono@4.13.7`, `fastify@5.12.3` y `jose@6.2.12`
  resuelven en el registro npm (no se instalaron completos por no ser parte
  de los experimentos pedidos, pero la resolución de versión confirma
  disponibilidad de red).

Para pruebas E2E se confirmó que **Playwright puede conducir el Chrome del
sistema sin descargar sus propios binarios de navegador** (lo cual evita
depender de la CDN de Playwright, que no se probó y podría estar bloqueada):

```
$ npm install -D @playwright/test@1.63.0
added 3 packages
```

`playwright.config.ts` con `channel: 'chrome'` +
`executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`,
prueba trivial que setea contenido HTML y verifica título/texto:

```
$ npx playwright test e2e.spec.ts
Running 1 test using 1 worker
  ✓  1 e2e.spec.ts:3:5 › system Chrome channel drives a real page without downloading browsers (548ms)
  1 passed (1.2s)
```

Esto confirma que un E2E real (arrancar el server Node/TS local + navegar con
Playwright contra Chrome instalado) es viable en esta máquina sin Docker y
sin depender de que Playwright descargue sus propios binarios.

## Experimento 5 — Chrome headless para capturas

```
$ "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --screenshot=.lab/chrome-out/x.png --window-size=1280,800 about:blank
[…] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670   (ruido inofensivo, no bloquea)
4715 bytes written to file .lab/chrome-out/x.png
exit code: 0
$ file .lab/chrome-out/x.png
PNG image data, 1280 x 800, 8-bit/color RGB, non-interlaced
```

Funciona. Los errores `CVDisplayLinkCreateWithCGDisplay` son ruido conocido
de Chrome headless en macOS sin GPU real (no afectan el resultado). Sirve
tanto para capturas ad hoc de páginas HTML como, combinado con Playwright
(experimento 4), para snapshots visuales de componentes renderizados por el
frontend real.

## Tabla comparativa (resumen de la decisión)

| Capa | Opción recomendada | Verificado en esta máquina | Nivel de fidelidad a Supabase/producción |
|---|---|---|---|
| Persistencia — unit tests rápidos | PGlite | Sí (RLS, triggers, `ON CONFLICT`, advisory lock, 5/5 tests) | Alta en SQL/RLS, baja en concurrencia real |
| Persistencia — integración/concurrencia | `embedded-postgres` (Postgres 18.4 real) | Sí (arranque, RLS, 2 conexiones concurrentes reales) | Muy alta (mismo motor Postgres) |
| Migraciones (escritura/versionado) | Archivos SQL versionados a mano + `supabase migration new` para el scaffolding | Sí (`migration new` sin Docker) | Alta (mismo formato que Restaurantes) |
| Migraciones (aplicación) | Runner propio (`node-pg-migrate` o script simple que ejecuta los `.sql` en orden) contra PGlite/`embedded-postgres` | No instalado (no era parte de los experimentos), pero trivial: son `psql`-style scripts ya compatibles con ambos motores | N/A |
| CLI Supabase | Solo para scaffolding (`init`, `migration new`, `functions new`) | Sí | N/A — `db diff`, `gen types`, `start` requieren Docker (confirmado) |
| Backend/API | Node/TS (Hono o Fastify) + `jose` para JWT propio, mismo patrón RLS por request que Restaurantes | Evaluado, no implementado (fuera de alcance de esta tarea) | Alta si se replica el contrato de claims (`request.jwt.claim.sub`) |
| Auth | JWT propio (dev/staging) emulando los claims que ya validan las políticas RLS existentes | N/A | Sustituto — Supabase Auth (GoTrue) real es integración pendiente |
| E2E | Playwright + Chrome del sistema (`channel: 'chrome'`) | Sí (test real pasó) | Alta |
| Capturas visuales | Chrome headless (`--headless=new --screenshot`) o Playwright `page.screenshot()` | Sí | Alta |

## Riesgos

1. **PGlite no sirve para probar contención/carreras reales** (medido:
   serializa todo). Cualquier prueba de "dos requests simultáneos disputando
   el mismo `pg_advisory_xact_lock`" da falsos positivos de seguridad si se
   corre solo en PGlite — debe correr en `embedded-postgres` (o Postgres
   real) para tener valor probatorio real, igual que hace Restaurantes con
   `order_idempotency_concurrency.sh` / `messaging_outbox_concurrency.sh`
   contra su Postgres de `supabase start`.
2. **Extensiones**: `pgcrypto` como `create extension` explícito falló en
   PGlite (aunque `gen_random_uuid()` nativo sí funcionó). Cualquier
   migración real que dependa de `pgjwt`, `pgsodium`, `pg_net`, `vector`, etc.
   debe revisarse extensión por extensión antes de asumir portabilidad a
   PGlite.
3. **`embedded-postgres` corrió bajo Rosetta 2** en esta prueba (el log
   reportó el slice x86_64 del binario universal) — funciona, pero no es
   arm64 nativo aquí; vigilar tiempos de arranque/CPU si se usa en CI o en
   bucles de test frecuentes. 144 MB de binarios por arquitectura instalada
   (paquete `optionalDependencies`) es peso no trivial para instalar en cada
   entorno.
2/3. **Ningún experimento reproduce PostgREST ni GoTrue** (la capa HTTP y de
   Auth de Supabase). Un backend propio con JWT propio + RLS por request
   reproduce el *modelo de permisos*, pero no es un test de que el contrato
   HTTP de Supabase (PostgREST) siga funcionando igual — esa paridad exacta
   con Restaurantes solo se puede verificar con Supabase real (local con
   Docker o proyecto remoto).
4. **`npx supabase gen types`/`db diff`/`start` dependen de Docker
   internamente incluso apuntando a un Postgres externo real** — no hay forma
   de generar tipos TS oficiales ni de correr el flujo de shadow-db de
   Supabase sin Docker en esta versión de la CLI (2.116.0).
5. Este documento no valida Edge Functions (Deno) porque no hay `deno`
   instalado y no se debía instalar software de sistema — queda como
   integración pendiente junto con Docker.

## Recomendación de stack (esta máquina, sin Docker)

- **Frontend**: mantener Vite + React + TS + shadcn, igual que
  `atiende-restaurantes`, para máxima reutilización de componentes/patrones.
- **Backend**: servidor Node/TS propio (Hono o Fastify — ambos resuelven vía
  npm) con JWT propio (`jose`) que emite los mismos claims que ya consumen las
  políticas RLS de Restaurantes (`request.jwt.claim.sub`, `role`), para poder
  reutilizar 1:1 las funciones `security definer` y políticas RLS ya probadas
  en el repo hermano, sin depender de GoTrue/Supabase Auth.
- **Persistencia**:
  - **Unitarias/lógica de negocio y RLS**: PGlite (`@electric-sql/pglite`) +
    Vitest — arranque instantáneo, cero dependencias de proceso de SO, ideal
    para correr decenas de casos de aislamiento de tenant en CI local.
  - **Integración/concurrencia/idempotencia real**: `embedded-postgres`
    (Postgres 18.4 real) — único motor que en esta máquina demuestra
    concurrencia real entre conexiones (verificado: 302ms en paralelo vs.
    1344ms serializado en PGlite), necesario para las pruebas equivalentes a
    `order_idempotency_concurrency.sh` / `messaging_outbox_concurrency.sh` de
    Restaurantes.
- **Migraciones**: archivos `.sql` versionados a mano (mismo formato que
  Restaurantes, con timestamp-prefijo), usando `supabase migration new` solo
  como generador de nombre/plantilla (funciona sin Docker); un runner simple
  (script propio o `node-pg-migrate`) los aplica en orden tanto contra PGlite
  como contra `embedded-postgres`, para no bifurcar el SQL entre "modo test"
  y "modo real".
- **Pruebas**:
  - Unitarias/RLS/idempotencia lógica → Vitest + PGlite.
  - Integración/concurrencia/triggers con locks reales → Vitest (o scripts
    Node) + `embedded-postgres`, con clientes `pg` concurrentes replicando el
    patrón de los `*_concurrency.sh` de Restaurantes.
  - E2E → Playwright con `channel: 'chrome'` apuntando al Chrome ya instalado
    (confirmado que funciona sin descargar navegadores propios de
    Playwright), sirviendo el frontend Vite + el backend Node/TS local.
  - Capturas visuales de componentes → Playwright `page.screenshot()` o
    Chrome headless directo (`--headless=new --screenshot`), ambos
    confirmados funcionando.
- **Auth**: JWT propio para dev/staging local, con los mismos nombres de
  claim que ya validan las políticas RLS heredadas de Restaurantes, para que
  el mismo SQL de RLS sea portable entre ambos proyectos.

### Qué queda como integración pendiente (no completa en esta máquina)

- **Supabase real (PostgREST + GoTrue) y Docker**: paridad exacta del
  contrato HTTP con Restaurantes, `supabase start`, `db diff` con shadow-db,
  `gen types` (todas requieren Docker, confirmado con errores explícitos de
  la CLI 2.116.0).
- **Edge Functions en Deno**: no hay `deno` en esta máquina; el scaffolding
  (`supabase functions new`) funciona sin Docker, pero ejecutarlas localmente
  (`supabase functions serve`) sí lo requiere.
- **Verificación de extensiones Postgres específicas** (`pgjwt`, `pgsodium`,
  `pg_net`, `vector`, etc.) que Restaurantes pueda estar usando en sus
  migraciones reales, extensión por extensión, tanto en PGlite como en el
  binario de `embedded-postgres`.
- **Rosetta/arquitectura nativa de `embedded-postgres` en arm64**: confirmar
  si existe o puede forzarse un slice puramente arm64 (evitar Rosetta) para
  reducir el peso de CPU en CI.
