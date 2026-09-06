# @atiende-hoteles/analytics

`AnalyticsPort` (PostHog) + `ErrorReporterPort` (Sentry), hito **H12c**
(docs/referencia/08-inventario-punta-a-punta.md filas 33/34). Se usa tanto desde
`apps/api` (Node) como desde `apps/web` (navegador, vía Vite) -- por eso NO depende de
`@atiende-hoteles/mcp-shared` ni de `node:crypto` (ver comentario en `src/shared.ts`), y
ningún adaptador lee `process.env`/`import.meta.env` directamente: la config
(`apiKey`/`host`/`dsn`) se pasa por constructor, y cada lado del monorepo la lee con su
propio mecanismo.

## Activación SOLO tras consentimiento

Ningún adaptador se instancia con credenciales reales hasta que el visitante acepta el
banner de cookies/analítica (`apps/web/src/components/CookieConsentBanner.tsx`) --
`apps/web/src/lib/analytics.ts` guarda el consentimiento en `localStorage`
(`atiende_hoteles_consentimiento_analitica`) y solo entonces reemplaza el
`FakeAnalyticsAdapter` inicial por un adaptador real. En `apps/api` no hay "consentimiento
del visitante" (es tráfico server-to-server) -- ahí la activación depende solo de que
existan las variables de entorno.

## Sin PII, nunca

`track()`/`identify()`/`captureException()`/`captureMessage()` de TODOS los adaptadores
(reales y fake) pasan las propiedades por `hasDenylistedKey()` (lista de claves vedadas:
`email`, `telefono`, `curp`, `rfc`, `nombre_completo`, ...) y `containsLikelyPii()`
(escaneo de patrones: correo, teléfono MX, CURP, RFC, número de tarjeta) ANTES de
enviarlas -- si algo coincide, se lanza `AnalyticsPiiError` y el evento **no se envía**,
ni siquiera al adaptador fake. Prueba: `tests/adversarial/analytics-sin-pii.spec.ts`.

## Catálogo de eventos (`src/events.ts`)

`PRODUCT_EVENTS` es la única fuente de nombres de evento válidos -- `track()` no acepta
un string libre (tipado a `ProductEventName`). Añadir un evento nuevo significa añadir
una fila documentada ahí, nunca "inventarlo" en el sitio de la llamada.

## Adaptadores reales

**[PENDIENTE DE CREDENCIALES]**.

- `PostHogAdapter` -- requiere `apiKey`/`host` de un proyecto PostHog real (Capture API).
- `SentryAdapter` -- requiere `dsn` real. Server-only en este hito (patrón de Likida,
  `likida/src/lib/observability/sentry.ts`): `apps/web` no expone un DSN de cliente
  todavía -- eso implicaría además scrubbing de PII dentro del propio SDK del navegador
  (breadcrumbs de UI, `beforeSend` con la misma validación de `shared.ts`), fuera de
  alcance de H12c. `apps/api` sí puede instanciar `SentryAdapter` para errores 5xx del
  camino del dinero (mismo `buildMoneyAlertLog` que ya existe en `apps/api/src/lib/
  moneyAlert.ts`, ahora también reportado a Sentry si hay DSN).

## Adaptadores simulados

`FakeAnalyticsAdapter`/`FakeErrorReporterAdapter` (`simulated: true`) guardan lo
capturado en memoria (`events`/`identifications`/`reports`) para que las pruebas puedan
inspeccionar qué se hubiera enviado -- aplican EXACTAMENTE las mismas validaciones de
PII que los adaptadores reales.

## PENDIENTE DE CREDENCIALES (checklist de salida a producción)

- [ ] Proyecto PostHog (cloud US/EU o autoalojado) + `apiKey`/`host`.
- [ ] Proyecto Sentry + `dsn` (server-side, `apps/api`).
- [ ] Decisión sobre si algún día se activa un DSN de cliente en `apps/web` (requiere
      diseño de scrubbing adicional, no solo credenciales).
