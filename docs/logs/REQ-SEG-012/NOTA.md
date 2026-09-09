# REQ-SEG-012 (parcial) — evidencia (2026-09-08)

Criterio (`docs/REQUISITOS.md`): "Nunca debe persistirse PAN, CVV, e.firma
(.cer/.key/.pfx/.p12), tokens de API ni contraseñas en código, logs, fixtures, prompts
o commits; `.env` debe estar excluido del control de versiones; CI debe ejecutar
escaneo de secretos en cada PR." Alcance de este cambio: la parte de BÚSQUEDA/CONFIRMACIÓN
de código y fixtures (grep de patrones de tarjeta, "password", "cvv"), NO el escaneo de
secretos en CI (fuera del alcance pedido para este cambio).

## Búsquedas ejecutadas y resultado

Salida literal completa: `docs/logs/REQ-SEG-012/grep-secretos-20260908-225950.log`.

1. **`password`/`contraseña` con valor literal en código** — 11 coincidencias, TODAS
   son credenciales sintéticas de desarrollo/test, nunca un secreto real:
   - `postgres_dev_only_local` / `atiende_app_dev_only_local` (contraseñas del
     Postgres EMBEBIDO efímero de dev/test, `packages/db/src/engines.ts`,
     `packages/db/src/cli.ts`, `scripts/lib/pgClientBin.ts`, mismo patrón en un test de
     integración) — nombradas explícitamente `_dev_only_local`, no corresponden a
     ningún servicio externo real ni a producción (Supabase, ver `.env.example`).
   - `atiende-dev-2026` (`packages/db/src/seed.ts::DEV_SEED_PASSWORD`, usuario demo
     sembrado solo en el Postgres embebido de dev/test).
   - `hunter2-sintetico`, `"x"`, `"cualquiera"`, `"contraseña-incorrecta"` — valores de
     fixtures de test (login fallido, redacción de logs), explícitamente marcados como
     sintéticos o triviales.
   Ninguno es una credencial real de un sistema externo. No se requirió corrección.
2. **`cvv`/`cvc`** — todas las apariciones son: (a) el guard de detección/redacción
   `packages/domain-hotel/src/paymentFreeTextGuard.ts` (existe PARA evitar persistir
   CVV), (b) su test (`payment-free-text-guard.spec.ts`) usando el CVV `123` junto al
   número de tarjeta de prueba estándar de la industria `4111111111111111` como INPUT
   de un guard cuyo resultado esperado es `[CVV]` (ya redactado, nunca se afirma que se
   guarde el valor crudo), (c) la lista de REDACCIÓN de logs
   (`apps/api/src/logger.ts::SENSITIVE_FIELDS`), y (d) el propio chequeo estático
   `scripts/checks/no-pan-storage.ts`. Ningún caso persiste un CVV real. No se requirió
   corrección de contenido (sí se corrigieron 2 falsos positivos del chequeo estático,
   ver `docs/logs/REQ-SEG-005/NOTA.md`).
3. **Patrón de número de tarjeta (13-19 dígitos) en `tests/`** — 75 coincidencias.
   Revisadas por muestreo y por patrón: la inmensa mayoría son teléfonos sintéticos
   formato México (`+52`/`521...`, ej. `5215500000000`) usados como `guest_phone` en
   fixtures de WhatsApp/mensajería, y los UUIDs partidos por el regex (ej.
   `11111111-1111-1111` + `1111-111111111111`, falso positivo del propio regex sobre un
   UUID de prueba). El único caso que es un número de tarjeta de verdad es
   `4111111111111111` ("4111 1111 1111 1111"), el número de prueba Visa ESTÁNDAR de la
   industria de pagos (documentado así en el propio test:
   `payment-free-text-guard.spec.ts:7`: *"acepta un número de tarjeta de prueba
   Luhn-válido conocido (4111111111111111, Visa de prueba)"*), usado exclusivamente
   como input para probar que `detectAndRedactPaymentData()` lo detecta y redacta antes
   de guardarse — nunca se persiste crudo (ver `mensajeria.ts` líneas 154-156:
   `bodyParaGuardar = pago.redactedText`). No es un PAN real de ningún tarjetahabiente.
   No se requirió corrección.
4. **Archivos de e.firma (`.cer`/`.key`/`.pfx`/`.p12`)** — 0 encontrados en todo el
   repo (excluyendo `node_modules`).
5. **Patrones de API key conocidos** (AWS `AKIA...`, OpenAI `sk-...`/`sk_live_...`,
   GitHub `ghp_...`, Slack `xox...`, Google `AIza...`) — 0 encontrados. La única
   coincidencia de `Bearer ...` es `Bearer real-simulado-no-real` en
   `tests/unit/api/logger-redact.spec.ts`, un valor explícitamente nombrado como
   simulado, usado para probar que el header `Authorization` se redacta de los logs.
6. **`.env` en control de versiones** — `git ls-files | grep -E "\.env"` solo devuelve
   `apps/api/.env.example` y `apps/web/.env.example` (plantillas sin secretos reales,
   confirmado leyendo su contenido: todos los valores sensibles quedan vacíos con
   comentario explicando cómo generarlos). Ningún `.env` real está trackeado;
   `.gitignore` ya excluye `.env`/`.env.*`.

## Conclusión de esta búsqueda

No se encontró ningún caso REAL de PAN/CVV/e.firma/token de API/contraseña real
persistido en código, fixtures o `.env` trackeado. Se documenta como "parcial" (no
"hecho") porque el criterio también exige "CI debe ejecutar escaneo de secretos en cada
PR" — `.github/workflows/ci.yml` no corre hoy ningún escáner de secretos (gitleaks/
trufflehog) — y esa pieza está fuera del alcance pedido para este cambio (no se agregó
aquí para no duplicar/chocar con trabajo ya en curso sobre ese mismo requisito en otro
lugar del repo).
