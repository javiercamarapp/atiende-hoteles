# Corrección — Seguridad (H8): CORS y cabecera Retry-After del rate limit

Cierra los dos hallazgos restantes de `docs/auditoria-1/seguridad.md` que quedaron
explícitamente asignados al frente de backend/API (ver `docs/auditoria-1/
correccion-bd.md`, "pendiente/fuera de mandato": *"CORS sin restricción de origen y
rate limit en memoria (seguridad.md MEDIO/BAJO, corresponden al frente backend/
API)"*).

## [MEDIO] CORS sin restricción de origen — cerrado

**Hallazgo original**: `apps/api/src/app.ts:23`, `cors()` sin opciones usaba el
default de `hono/cors` (`Access-Control-Allow-Origin: *` para cualquier `Origin`).

**Corrección**:
- `apps/api/src/env.ts`: nueva variable `CORS_ALLOWED_ORIGINS` (lista separada por
  comas). Obligatoria y explícita en producción (sin default silencioso, mismo
  patrón que `JWT_SECRET`); fuera de producción cae a
  `http://localhost:5173,http://localhost:4173` (puertos de Vite dev/preview).
  Rechaza explícitamente el comodín `*`.
- `apps/api/src/app.ts`: `cors({ origin: deps.env.corsAllowedOrigins, ... })` — un
  origen fuera de la lista no recibe NINGUNA cabecera `Access-Control-Allow-Origin`
  (el navegador bloquea la lectura de la respuesta).

**Prueba** (`tests/integration/api/observabilidad.spec.ts`, describe "CORS: lista
explícita de orígenes por entorno", 3 casos):
1. Origen no permitido → `res.headers.get("access-control-allow-origin")` es `null`.
2. Origen permitido (de la lista de env) → la cabecera refleja exactamente ese
   origen.
3. Nunca se responde con `*`, incluso con un origen válido.

**Efecto lateral corregido en el mismo cambio**: dos specs E2E preexistentes
(`tests/e2e/login-real-y-resumen.spec.ts`, `tests/e2e/h4-reserva-real-desde-ui.spec.ts`,
de H2/H4) arrancan su propio `apps/api` en un puerto dinámico para probar el flujo
real de negocio — con CORS ahora restringido, ese origen dinámico necesitaba
declararse explícitamente vía `CORS_ALLOWED_ORIGINS` al spawnear el proceso (2 líneas
por archivo, sin tocar ninguna ruta de negocio).

## [BAJO] Rate limit en memoria de proceso, sin `Retry-After` — cabecera cerrada, límite compartido entre instancias sigue como deuda declarada

**Hallazgo original**: `apps/api/src/lib/rateLimit.ts:13-36`, `MemoryRateLimitStore`
guarda contadores en un `Map` local del proceso — el propio comentario del archivo ya
documentaba esto como decisión deliberada "por ahora" detrás de una interfaz
(`RateLimitStore`) pensada para un backend compartido (Redis).

**Qué se cerró en H8**: la parte de comportamiento observable por el cliente que
faltaba — un 429 sin `Retry-After` no le dice al cliente cuánto esperar.
- `apps/api/src/lib/errors.ts`: `ApiError` ahora acepta `headers` opcionales;
  `Errors.rateLimited(retryAfterSeconds)` adjunta `Retry-After` (segundos, redondeado
  hacia arriba) calculado del `resetAt` real del limitador.
- `apps/api/src/middleware.ts`: `ipRateLimit`/`userRateLimit` calculan
  `(resetAt - Date.now()) / 1000` y se lo pasan a `Errors.rateLimited`.
- `apps/api/src/app.ts` (`onError`): copia cualquier `headers` del `ApiError` a la
  respuesta real.

**Prueba**: `tests/adversarial/reserva-concurrencia-y-limites.spec.ts`
("una IP que excede el límite configurado recibe 429 con formato uniforme") ahora
además verifica `Retry-After` presente, numérico, `>0` y `<=60` (ventana configurada
de la prueba).

**Qué NO se cerró (deuda ya declarada, no oculta)**: el almacenamiento compartido
entre instancias (Redis u otro backend distribuido detrás de la interfaz
`RateLimitStore` ya existente) sigue sin construirse — un despliegue horizontal de
más de una instancia de `apps/api` sigue teniendo un límite efectivo más alto que el
declarado en `env.ts`, exactamente como documentó el hallazgo original. Este
comportamiento se deja registrado en `docs/runbooks/operacion.md` como limitación
conocida, no se simula una solución que no existe.

## Cabeceras de seguridad adicionales (no eran un hallazgo de auditoria-1, entregable explícito de H8)

`apps/api/src/app.ts` añade `hono/secure-headers`:
- `Strict-Transport-Security` solo cuando `NODE_ENV=production` (nunca en
  dev/test, donde declararla sería información falsa sobre un servidor HTTP plano).
- `X-Content-Type-Options: nosniff` siempre.
- `Content-Security-Policy: frame-ancestors 'none'` (esta API nunca sirve HTML
  embebible en un iframe de otro origen) + `X-Frame-Options: DENY`.

Prueba: `tests/integration/api/observabilidad.spec.ts`, describe "Cabeceras de
seguridad" (4 casos, incluye NODE_ENV=production explícito para confirmar que HSTS sí
aparece ahí).

## Compuertas

`npm run lint` (0 errores), `npm run typecheck` (0 errores), `npm test` (448
pruebas verdes: unit 323 (+1 skip preexistente) + integration 59 + adversarial 66),
`npm run build` OK,
`npm run test:e2e` (25 passed / 3 skipped honestos). Logs:
`docs/logs/h8-ci-{lint,typecheck,test,build,e2e}.log`.
