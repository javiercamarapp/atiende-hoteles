# Matriz de variables de entorno — por app y entorno

Convenciones: **Secreto** = nunca en git, nunca en un log, rotable sin tocar código.
**Dónde** = el sistema donde se configura el valor real (nunca este repositorio).
Fuente de la lista base: `apps/api/.env.example`, `apps/web/.env.example`,
`packages/db/README.md`, `supabase/config.toml`, `deploy/api/docker/fly.toml`.

## `apps/api` (backend Hono)

| Variable | Secreto | Obligatoria en producción | Dónde se configura | Notas |
|---|:---:|:---:|---|---|
| `NODE_ENV` | No | Sí (`production`) | Vercel/Fly (env del proyecto) | Sin `production` explícito, cae a defaults de desarrollo (inseguros a propósito, `apps/api/src/env.ts`). |
| `PORT` | No | No (`3001` default) | Vercel/Fly | Fly expone `internal_port=3001` (`fly.toml`) — debe coincidir. |
| `JWT_SECRET` | **Sí** | Sí | Vercel/Fly secrets | `openssl rand -base64 48`. Rotarlo invalida TODAS las sesiones activas (documentar ventana de mantenimiento). |
| `ACCESS_TOKEN_TTL_SECONDS` | No | No (`900`) | Vercel/Fly | — |
| `REFRESH_TOKEN_TTL_SECONDS` | No | No (`2592000`) | Vercel/Fly | — |
| `CORS_ALLOWED_ORIGINS` | No (pero sensible) | Sí | Vercel/Fly | Lista exacta separada por comas, nunca `*` (`apps/api/src/env.ts` rechaza `*`). Incluir el dominio real de `apps/web` de ESE entorno (preview y producción son orígenes distintos). |
| `SUPABASE_DB_HOST` | No (es un hostname, no secreto por sí solo) | Sí (en Opción a/b de `deploy/`) | Vercel/Fly | `db.<project-ref>.supabase.co` (Supabase → Settings → Database). |
| `SUPABASE_DB_PORT` | No | No (`5432` default) | Vercel/Fly | Usar `6543` si se conecta vía el *pooler* (pgbouncer) de Supabase en vez de la conexión directa. |
| `SUPABASE_DB_PASSWORD_APP` | **Sí** | Sí | Vercel/Fly secrets | Contraseña REAL de `atiende_app` fijada con `ALTER ROLE` tras `supabase db push` (`docs/runbooks/migracion-a-supabase.md` paso 6) — **nunca** la del placeholder de la migración transformada. |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | No | No (`300`) | Vercel/Fly | En memoria por proceso (LAUNCH-022) — ver `deploy/README.md` "Recomendación". |
| `RATE_LIMIT_PER_USER_PER_MINUTE` | No | No (`600`) | Vercel/Fly | ídem |
| `LOG_LEVEL` | No | No (`info`) | Vercel/Fly | — |
| `LOG_PRETTY` | No | No (sin definir) | Vercel/Fly | Dejar SIN definir en producción (JSON por línea, nunca formato legible). |
| `METRICS_TOKEN` | **Sí** (si se define) | No | Vercel/Fly secrets | Si se define, `/metrics` exige `X-Metrics-Token`; sin definir, queda abierto (pensarlo solo si `/metrics` no está expuesto a internet). |

## `apps/web` (SPA Vite)

Todas se inlinean en **tiempo de build** (`import.meta.env.*`) — cambiar un valor
requiere volver a compilar, no solo reiniciar/redeployar sin rebuild.

| Variable | Secreto | Obligatoria en producción | Dónde se configura | Notas |
|---|:---:|:---:|---|---|
| `VITE_API_URL` | No | Sí | Vercel (env del proyecto de `apps/web`) | Sin barra final. Alimenta también `connect-src` de la CSP (`apps/web/tools/cspMetaPlugin.ts`). |
| `VITE_SUPABASE_URL` | No | No (hoy no se usa) | Vercel | Reservada para si `apps/web` llega a hablar con Supabase directo (Storage/Realtime) — hoy todo pasa por `apps/api`. Si se define, entra a `connect-src` de la CSP automáticamente. |

## Supabase (Auth) — `supabase/config.toml`

| Variable | Secreto | Dónde se configura | Notas |
|---|:---:|---|---|
| `SUPABASE_AUTH_SITE_URL` | No | `supabase secrets set` / CLI antes de `db push` | Dominio de `apps/web` de ESE entorno. |
| `SUPABASE_AUTH_REDIRECT_URL` | No | ídem | `<SITE_URL>/login` — único retorno autorizado (mismo criterio que `atiende-restaurantes/docs/deployment-domains.md`). |
| `SUPABASE_AUTH_GOOGLE_CLIENT_ID` | **Sí** | ídem | Google Cloud Console (proyecto OAuth, H12a). |
| `SUPABASE_AUTH_GOOGLE_SECRET` | **Sí** | ídem | ídem |
| `SUPABASE_AUTH_GOOGLE_REDIRECT_URI` | No | ídem | `https://<project-ref>.supabase.co/auth/v1/callback`. |

## Por entorno (resumen)

| Entorno | `apps/api` NODE_ENV | `CORS_ALLOWED_ORIGINS` apunta a | `VITE_API_URL` apunta a |
|---|---|---|---|
| Desarrollo local | `development` (default) | `http://localhost:5173,http://localhost:4173` (default) | `http://localhost:3001` |
| Preview (rama/PR) | `production` | dominio de preview de `apps/web` (`https://<preview>.vercel.app`) | URL del preview de `apps/api` |
| Producción | `production` | dominio final de `apps/web` | dominio final de `apps/api` |

**Dominio final:** aún no decidido (LAUNCH-010, `docs/BLOQUEOS.md` D-006) — este
documento usa `app.atiendehoteles.com`/`api.atiendehoteles.com` como placeholders en
otros archivos (`apps/web/public/sitemap.xml`, `apps/web/public/robots.txt`); actualizar
cuando el fundador confirme el dominio real.
