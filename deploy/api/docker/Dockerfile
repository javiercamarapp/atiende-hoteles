# H12b · LAUNCH-010/D-006 — Opción (b): Dockerfile + fly.toml. RECOMENDADA en
# deploy/README.md sobre la Opción (a) (adaptador Vercel): esta API no tiene build/bundle
# (corre TS fuente con el type-stripping nativo de Node, ver apps/api/README.md) y
# necesita un `pg.Pool` de larga vida + un proceso persistente para sus 3 schedulers en
# proceso (night audit, purga de bóveda de identidad, purga de conversaciones —
# apps/api/src/server.ts) y el worker de outbox — todo eso encaja mal con el modelo
# "función sin estado, de vida corta" de Vercel Functions, y encaja bien con un
# contenedor de larga vida.
#
# NO SE EJECUTA `docker build` en este entorno (sin Docker instalado, docs/BLOQUEOS.md
# B-002) — este archivo se validó con `docker run --rm -i hadolint/hadolint < Dockerfile`
# NO disponible tampoco; la validación aplicada aquí es sintáctica (ver deploy/README.md
# "Cómo se verificó", que documenta exactamente qué se pudo y qué no se pudo probar sin
# Docker).

# Node 22+ (apps/api/package.json "engines"), imagen slim oficial.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ── Dependencias (capa cacheable) ────────────────────────────────────────────
# Copia SOLO los manifiestos primero para que `npm ci` se cachee entre builds mientras
# el código fuente cambia sin tocar ninguna dependencia -- workspaces de npm requieren
# los `package.json` de cada paquete presentes ANTES de `npm ci` (resuelve símlinks del
# workspace), así que se copian todos, no solo el de la raíz.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain-hotel/package.json packages/domain-hotel/package.json
COPY packages/mcp-servers/cfdi/package.json packages/mcp-servers/cfdi/package.json
COPY packages/mcp-servers/payments/package.json packages/mcp-servers/payments/package.json
COPY packages/mcp-servers/shared/package.json packages/mcp-servers/shared/package.json
COPY packages/mcp-servers/whatsapp/package.json packages/mcp-servers/whatsapp/package.json
COPY packages/ui/package.json packages/ui/package.json
# `npm ci --omit=dev`: esta imagen SOLO corre `apps/api` (sin build), no necesita
# devDependencies (vitest, eslint, playwright, etc.) -- reduce superficie e imagen.
RUN npm ci --omit=dev --ignore-scripts

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY apps/api apps/api
COPY packages/agent-core packages/agent-core
COPY packages/db packages/db
COPY packages/domain-hotel packages/domain-hotel
COPY packages/mcp-servers packages/mcp-servers
COPY packages/config packages/config

# Sin `USER root` expreso al final: `node:22-slim` YA define el usuario `node` (uid 1000)
# como no-root -- se conmuta explícitamente para que quede documentado, no por si acaso.
USER node

EXPOSE 3001

# Ver `apps/api/README.md`/`deploy/env-matrix.md` para las variables obligatorias en
# producción (JWT_SECRET, CORS_ALLOWED_ORIGINS, SUPABASE_DB_HOST, SUPABASE_DB_PASSWORD_APP).
# `--experimental-transform-types`: mismo flag que `apps/api/package.json` "start" (soporta
# "parameter properties" de TS que usa `packages/mcp-servers/payments`, a diferencia de
# `--experimental-strip-types`, ver deploy/api/vercel/verify-local.ts).
CMD ["node", "--experimental-transform-types", "apps/api/src/server.ts"]
