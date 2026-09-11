# Despliegue — H12b (LAUNCH-010/D-006)

Este directorio prepara y VERIFICA LOCALMENTE la configuración de despliegue. Ningún
agente crea proyectos reales en Vercel/Supabase/Fly ni ejecuta un despliegue real — eso
lo decide y ejecuta el fundador (👤, ver cada README/runbook).

## Qué hay aquí

```
apps/web/vercel.json           # SPA (rewrites, cabeceras, ignoreCommand [deploy])
apps/web/tools/cspMetaPlugin.ts# CSP con connect-src resuelto por entorno (build-time)
deploy/api/vercel/             # Opción (a): adaptador Vercel para Hono
deploy/api/docker/             # Opción (b): Dockerfile + fly.toml — RECOMENDADA
deploy/env-matrix.md           # Variables de entorno por app/entorno, qué es secreto
scripts/preflight-deploy.ts    # Verifica build+env+migraciones+tests+audit+bundle
```

## Recomendación: Opción (b) — Docker/Fly, no Vercel, para `apps/api`

Registrada como **D-006** en `docs/BLOQUEOS.md` para que el fundador confirme o cambie.
Razones (verificadas en este repo, no genéricas):

1. **Sin build/bundle.** `apps/api` corre TypeScript fuente directamente con el
   type-stripping nativo de Node (`apps/api/README.md` "No hay paso de build") — el
   modelo de Vercel Functions (`@vercel/node`/`hono/vercel`) SÍ puede envolver esto
   (verificado, ver `deploy/api/vercel/verify-local.ts`), pero el bundler de Vercel
   necesita resolver imports relativos hacia `apps/api/src/*`/`packages/*` **fuera** del
   directorio raíz del proyecto (`deploy/api/vercel`) — el comportamiento exacto de
   "incluir archivos fuera del Root Directory" en un monorepo npm workspaces solo se
   puede confirmar con un despliegue real (no se puede verificar sin crear el proyecto).
2. **Proceso de larga vida.** `apps/api/src/server.ts` arranca 3 *schedulers* en
   proceso (night audit, purga de bóveda de identidad, purga de conversaciones) más el
   worker de outbox — todos asumen que el proceso sigue vivo entre invocaciones. Una
   función serverless (Vercel) se recicla/enfría entre requests: esos *schedulers*
   dejarían de correr de forma confiable (habría que moverlos a Vercel Cron, que factura
   y opera distinto). Un contenedor Docker/Fly no tiene ese problema.
3. **Rate limiting en memoria (LAUNCH-022).** `apps/api/src/lib/rateLimit.ts` guarda el
   estado en memoria del proceso — con múltiples instancias serverless sin estado
   compartido, el límite deja de ser efectivo. Con Fly (`min_machines_running: 1`,
   arrancado explícito en `fly.toml`) el problema es el mismo si se escala a >1 máquina,
   pero al menos es una decisión explícita de escalado, no un efecto secundario del
   modelo de invocación.
   **Actualización (patrón Likida/atiende.ai #3):** por instrucción del audit que originó
   este cambio, no se aprovisiona Redis nuevo — en su lugar ya existe `PostgresRateLimitStore`
   (mismo archivo `rateLimit.ts`), un store REAL (no un esqueleto sin probar, ver
   `tests/unit/api/postgres-rate-limit-store.spec.ts`) respaldado por
   `public.rate_limit_bucket` (migración 0131), compartido entre TODAS las instancias
   porque todas hablan al mismo Postgres. Con decisión explícita fail-open/fail-closed
   ante una falla del store (`RateLimitFailurePolicy`, algo que `MemoryRateLimitStore`
   nunca necesitó porque no puede fallar). **No** se sustituyó como default en
   `server.ts`/`deploy/api/vercel/api/[[...route]].ts` — wirearlo ahí agrega un
   round-trip a Postgres en cada request, una decisión de costo/latencia que le
   corresponde a quien decide desplegar multi-instancia, no a este cambio. Queda
   disponible y probado para cuando esa decisión se tome.

La Opción (a) queda completa y funcional (ver "Cómo se verificó" abajo) por si el
fundador prefiere Vercel para todo el stack (un solo proveedor) — es una decisión de
producto/costo, no solo técnica.

## Opción (a) — Vercel + `hono/vercel`

`deploy/api/vercel/api/[[...route]].ts` envuelve `createApp()` (la MISMA app que usa
`apps/api/src/server.ts`) con `handle()` de `hono/vercel` (literalmente
`(req: Request) => app.fetch(req)`). Producción se conecta a Postgres gestionado con
`openManagedPostgres()` (`packages/db/src/engines.ts`) usando el rol de mínimo
privilegio `atiende_app` — **nunca** un superusuario ni `embedded-postgres` (eso
seguiría existiendo solo para desarrollo/CI, ADR-003).

**Cómo desplegarla** (👤 usuario, cuando decida usar esta opción):
1. Crear un proyecto Vercel nuevo con **Root Directory = `deploy/api/vercel`**.
2. Configurar las variables de `deploy/env-matrix.md` (fila "apps/api (Vercel opción a)").
3. El `ignoreCommand` de `deploy/api/vercel/vercel.json` solo construye si el commit
   trae `[deploy]` (mismo patrón que `apps/web/vercel.json`, portado de `likida/vercel.json`).

**Por qué `admin` de producción no es superusuario** (`packages/db/src/engines.ts`
`openManagedPostgres`): a diferencia de `embedded-postgres` en desarrollo (donde
`admin` es el superusuario del cluster, usado para aplicar migraciones/seed), en
producción NINGÚN proceso de `apps/api` aplica migraciones — eso lo hace el fundador
con `supabase db push` (GOB-058, `docs/runbooks/migracion-a-supabase.md`). Embeber una
credencial de superusuario en el runtime de la API sería una superficie de ataque
innecesaria: si el proceso se ve comprometido, el máximo daño posible queda acotado al
mismo privilegio (`atiende_app`) que ya tiene cualquier request autenticado normal.

## Opción (b) — Docker + Fly.io

`deploy/api/docker/Dockerfile` (multi-stage: `deps` con `npm ci --omit=dev`, `runtime`
con el código fuente, usuario `node` sin privilegios) + `deploy/api/docker/fly.toml`
(healthcheck contra `/health`, `min_machines_running: 1` porque los *schedulers* en
proceso necesitan una máquina siempre corriendo).

**Cómo desplegarla** (👤 usuario):
```bash
fly launch --no-deploy   # crea la app, usa deploy/api/docker/fly.toml como base
fly secrets set JWT_SECRET=... CORS_ALLOWED_ORIGINS=... SUPABASE_DB_HOST=... SUPABASE_DB_PASSWORD_APP=...
fly deploy
```

## Cómo se verificó (sin Docker ni proyecto real, B-002)

| Verificación | Comando/evidencia |
|---|---|
| El wiring `hono/vercel` + `createApp()` produce una `Response` HTTP real | `node --experimental-transform-types deploy/api/vercel/verify-local.ts` → `/health` 200 `{status:"ok"}` |
| El código de producción (`openManagedPostgres`) arranca y falla HONESTO sin un Postgres real | `NODE_ENV=production SUPABASE_DB_HOST=<host-falso> SUPABASE_DB_PASSWORD_APP=x node --experimental-transform-types apps/api/src/server.ts` → servidor arranca, `/health` 200, `/ready` 503 (`ENOTFOUND`, no falla en el arranque) |
| `NODE_ENV=production` SIN `SUPABASE_DB_HOST`/`SUPABASE_DB_PASSWORD_APP` nunca arranca `embedded-postgres` "por accidente" | mismo comando sin esas dos variables → lanza error explícito antes de escuchar ningún puerto |
| El árbol de dependencias del Dockerfile (`deps` stage) resuelve con `npm ci --omit=dev` | reproducido con un directorio temporal que copia EXACTAMENTE los `package.json` que el `Dockerfile` copia (sin Docker) → `npm ci` exitoso |
| El `runtime` stage arranca de verdad con solo esos archivos copiados | mismo directorio temporal + código fuente completo copiado → servidor arranca, `/health` 200 |
| Sintaxis de `apps/web/vercel.json`, `deploy/api/vercel/vercel.json` | `node -e "JSON.parse(fs.readFileSync(...))"` |
| Sintaxis de `deploy/api/docker/fly.toml` | `python3 -c "import tomllib; tomllib.load(...)"` |
| Tipos del adaptador Vercel (`hono/vercel`, imports relativos) | `npx tsc --noEmit -p deploy/api/vercel/tsconfig.json` |
| **PENDIENTE** (necesita Vercel/Fly reales) | Un despliegue real a cualquiera de las dos opciones; que el bundler de Vercel resuelva imports fuera del Root Directory en un monorepo npm workspaces (riesgo documentado arriba); latencia/backoff real de `pg.Pool` contra Supabase por red pública (aquí solo se verificó el camino de error `ENOTFOUND` con un host inexistente, no una conexión real). |

## Por qué CSP en dos sitios (`apps/web`)

`apps/web/vercel.json` (cabeceras estáticas: X-Frame-Options, HSTS, etc. — no dependen
de ninguna variable de entorno) + `apps/web/tools/cspMetaPlugin.ts` (inyecta
`<meta http-equiv="Content-Security-Policy">` en cada `vite build`, con `connect-src`
resuelto de `VITE_API_URL`/`VITE_SUPABASE_URL` de ESE build). Un `vercel.json` estático
no puede interpolar variables de entorno dentro de un valor de cabecera — por eso la
parte de la CSP que sí depende del entorno (`connect-src`) vive en el HTML generado en
build-time, no en `vercel.json`. La única cabecera que la etiqueta `<meta>` NO puede
expresar es `frame-ancestors` — cubierta igual por `X-Frame-Options: DENY` en
`vercel.json` (mismo criterio "cinturón y tirantes" que usa `likida/next.config.ts`
entre CSP y X-Frame-Options).
