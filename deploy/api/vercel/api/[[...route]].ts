// H12b · LAUNCH-010/D-006 — Opción (a): adaptador Vercel para Hono.
//
// Función serverless "catch-all" (`[[...route]].ts` captura cualquier ruta bajo esta
// carpeta `api/`, patrón estándar de Vercel para un backend de un solo router). Envuelve
// la MISMA `createApp()` que usa `apps/api/src/server.ts` con `hono/vercel`, cuyo `handle()`
// es literalmente `(req: Request) => app.fetch(req)` (ver
// node_modules/hono/dist/adapter/vercel/handler.js) -- ninguna lógica de negocio vive
// aquí, solo el cableado de dependencias de producción.
//
// CÓMO DESPLEGAR ESTE DIRECTORIO (proyecto Vercel separado del de `apps/web`):
//   1. USUARIO crea un proyecto Vercel nuevo (Settings → Root Directory:
//      "deploy/api/vercel") -- este agente no crea proyectos Vercel (ver encargo).
//   2. Variables de entorno del proyecto: ver deploy/env-matrix.md fila "apps/api
//      (Vercel opción a)".
//   3. `vercel.json` de esta carpeta define el runtime Node y las cabeceras -- ver ese
//      archivo.
//
// VERIFICADO LOCALMENTE (sin desplegar, ver deploy/README.md "Cómo se verificó"):
//   - `npx tsc --noEmit` sobre este árbol.
//   - Un script Node importa `handler` de este archivo y lo invoca con un `Request`
//     real contra un `embedded-postgres` efímero (sustituyendo a `openManagedPostgres`
//     solo para la prueba local -- en producción real se usa `openManagedPostgres`
//     contra Supabase, ver más abajo) -- confirma que `hono/vercel` + `createApp()`
//     producen una `Response` HTTP correcta de punta a punta.
//   - PENDIENTE (necesita Vercel real): que el bundler de Vercel resuelva las rutas
//     relativas de import hacia `apps/api/src/*` y `packages/*` DESDE `Root Directory`
//     configurado en `deploy/api/vercel` -- el comportamiento exacto de "incluir
//     archivos fuera del Root Directory" en un monorepo npm workspaces solo se puede
//     confirmar con un despliegue real (documentado en deploy/README.md como riesgo
//     conocido de la Opción (a), y es la razón por la que deploy/README.md recomienda
//     la Opción (b) en su lugar).
import { handle } from "hono/vercel";
import { createApp } from "../../../../apps/api/src/app.ts";
import { loadEnv } from "../../../../apps/api/src/env.ts";
import { rootLogger } from "../../../../apps/api/src/logger.ts";
import { RateLimiter } from "../../../../apps/api/src/lib/rateLimit.ts";
import { MetricsRegistry } from "../../../../apps/api/src/metrics.ts";
import { openManagedPostgres } from "../../../../packages/db/src/index.ts";
import type { AppDeps } from "../../../../apps/api/src/types.ts";

export const config = {
  // Node.js runtime (no `edge`): esta API usa `pg` (TCP real a Postgres), que el
  // runtime Edge de Vercel no soporta -- mismo motivo que
  // `atiende-restaurantes`/`likida` mantienen su capa de datos fuera de Edge.
  runtime: "nodejs",
};

// H12b · "Por qué `admin` de producción no es superusuario" (ver también
// packages/db/src/engines.ts `openManagedPostgres`, comentario de cabecera): el pool de
// producción se conecta como `atiende_app` -- el MISMO rol de mínimo privilegio que la
// app usa en desarrollo, nunca `postgres`/superusuario. Las migraciones contra el
// proyecto Supabase real las aplica el fundador con `supabase db push`
// (docs/runbooks/migracion-a-supabase.md, GOB-058) -- este proceso NUNCA las aplica.
function buildProductionDeps(): AppDeps {
  const env = loadEnv(process.env);

  const dbHost = process.env.SUPABASE_DB_HOST;
  const dbPassword = process.env.SUPABASE_DB_PASSWORD_APP;
  if (!dbHost || !dbPassword) {
    throw new Error(
      "SUPABASE_DB_HOST/SUPABASE_DB_PASSWORD_APP no están configuradas -- ver deploy/env-matrix.md. " +
        "Esta función NUNCA arranca un Postgres embebido (eso es exclusivo de desarrollo, ADR-003).",
    );
  }

  const engine = openManagedPostgres({
    host: dbHost,
    port: process.env.SUPABASE_DB_PORT ? Number(process.env.SUPABASE_DB_PORT) : 5432,
    user: "atiende_app",
    password: dbPassword,
  });

  return {
    engine,
    env,
    logger: rootLogger,
    ipLimiter: new RateLimiter({ limit: env.rateLimitPerIpPerMinute, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: env.rateLimitPerUserPerMinute, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
  };
}

// H12b · Nota deliberada sobre el `RateLimiter` en memoria (LAUNCH-022, `apps/api/src/lib/
// rateLimit.ts`): cada invocación fría de una función serverless arranca con un
// `RateLimiter` NUEVO y vacío -- en Vercel (múltiples instancias concurrentes, sin estado
// compartido entre invocaciones) el límite deja de ser efectivo de verdad. Documentado
// como brecha conocida de la Opción (a) en deploy/README.md "Comparación", no resuelto
// aquí (mover a Redis/Upstash es LAUNCH-022, fuera del alcance de este adaptador).
const app = createApp(buildProductionDeps());

export const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
