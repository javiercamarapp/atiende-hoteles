# REQ-SEG-011 — evidencia (2026-09-08)

Criterio (`docs/REQUISITOS.md`): "Los tokens de VCC/pre-autorización no utilizados
deben purgarse/expirar automáticamente; la retención de datos de tarjeta se limita a lo
estrictamente necesario para conciliación y disputa de contracargo." Estado previo en
la matriz: `pendiente-credenciales` (depende de: pasarela).

## Estado real encontrado al llegar

`public.payment` ya modelaba lo necesario (migración `0030_folio_engine.sql`):
`status` incluye `'autorizado'`/`'expirado'`, `token_ref` (referencia opaca del PSP) y
`preauth_expires_at`. `PaymentProviderPort.capturePreAuth()`
(`packages/mcp-servers/payments/src/port.ts`) ya lanza `PreAuthExpiredError` si se
intenta capturar una pre-autorización vencida. Pero — igual que
`identity_vault`/`REQ-SEG-004` antes de `jobs/purgeIdentityVault.ts` (auditoria-2/legal
[CRITICO] "la purga existe y está probada pero no corre en ningún proceso real") — NO
existía ningún job/cron/scheduler que recorriera la tabla `payment` para expirar y
purgar pre-autorizaciones vencidas. Confirmado antes del cambio:

```
$ grep -rln "preauth_expires_at\|preAuthExpiresAt\|preauth.expired\|PreAuthExpired" --include="*.ts" . | grep -v node_modules
tests/unit/mcp-servers/payments/adapter-swap.spec.ts
packages/mcp-servers/payments/src/port.ts
packages/mcp-servers/payments/src/adapters/fake-payment-adapter.ts
```
Ningún resultado bajo `apps/api/src/jobs/` — no existía el job.

## Cambio: job de purga por lote (mismo patrón que `purgeIdentityVault.ts`)

- `apps/api/src/jobs/purgePaymentPreauth.ts` — `purgeExpiredPaymentPreauth(db, opts)`:
  UPDATE por lote (`batchSize`, default 500) de `payment` donde
  `status = 'autorizado' and preauth_expires_at < now()` → `status = 'expirado'`,
  `token_ref = null` (el token ya no sirve para nada: una pre-auth vencida nunca se
  puede capturar). El resto de la fila (monto, folio, `external_ref`, timestamps) se
  conserva — es lo "estrictamente necesario para conciliación y disputa de
  contracargo" que el propio requisito exige seguir teniendo. Nunca toca una fila
  vigente, ya capturada/reembolsada/fallida, ni un cobro directo sin pre-auth
  (`preauth_expires_at is null`). Registra `record_audit_log` cuando se da
  `hotelId`+`tenantId` (planificador por hotel).
- `apps/api/src/jobs/purgePaymentPreauthScheduler.ts` — planificador EN PROCESO
  (`setInterval`, 1h por defecto), lock por hotel en memoria, mismo patrón EXACTO que
  `purgeIdentityVaultScheduler.ts`.
- `apps/api/src/server.ts` — arranca el scheduler junto a los otros 3 (night audit,
  bóveda de identidad, conversaciones) y lo detiene en `shutdown()`.
- `apps/api/src/metrics.ts` — `payment_preauth_purged_total{hotel="..."}` (contador
  Prometheus), mismo patrón que `identity_vault_purged_total`/`conversations_purged_total`.
- `scripts/purge-payment-preauth.ts` — CLI standalone (cron del sistema operativo),
  mismo patrón que `scripts/purge-identity-vault.ts`.
- `tests/integration/payment-preauth-purga.spec.ts` — prueba REAL contra
  embedded-postgres (no simulada): 4 casos —
  1. purga por lote (7 filas vencidas en lotes de 3 → 3 lotes) y deja intactas una
     vigente, una ya capturada, y un cobro directo sin pre-auth.
  2. sin vencidas, 0 filas / 0 lotes.
  3. filtra por `hotelId` (planificador por hotel) sin tocar el `payment` de otro
     hotel del mismo seed.
  4. rechaza `batchSize` inválido.

## Salida real

```
$ npx vitest run --config vitest.config.ts tests/integration/payment-preauth-purga.spec.ts --pool=forks --poolOptions.forks.singleFork

 RUN  v3.2.7 /private/tmp/hoteles-fix-payment-security

 ✓ tests/integration/payment-preauth-purga.spec.ts (4 tests) 816ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```
Log completo: `docs/logs/REQ-SEG-011/vitest-purga-preauth-20260908-225950.log`.

```
$ npx eslint apps/api/src/server.ts apps/api/src/metrics.ts apps/api/src/jobs/purgePaymentPreauth.ts apps/api/src/jobs/purgePaymentPreauthScheduler.ts scripts/purge-payment-preauth.ts scripts/checks/no-pan-storage.ts
(sin salida = 0 errores/warnings)
```
Log completo: `docs/logs/REQ-SEG-011/eslint-20260908-225950.log`.

## Qué NO se cerró (honesto)

1. **`npm run typecheck` / `tsc --noEmit -p apps/api/tsconfig.json` está roto en
   `origin/main` de forma PREVIA e independiente a este cambio**: el commit `5e21c12`
   ("feat(REQ-OBS-007)...") agregó a `packages/domain-hotel/src/index.ts` imports hacia
   6 archivos que nunca se agregaron al repo (`./voiceGuardrails.ts`,
   `./pl/usaliPL.ts`, `./tickets/slaPolicy.ts`, `./marketingTemplateLinter.ts`,
   `./conversationalGuardrails.ts`, `./guestContactChangeOtp.ts`). Esto NO solo rompe
   el typecheck: rompe en TIEMPO DE EJECUCIÓN cualquier import de
   `@atiende-hoteles/domain-hotel` — confirmado corriendo
   `tests/unit/domain-hotel/*` (16 de 18 archivos fallan con
   `Cannot find module './voiceGuardrails.ts'`) y
   `tests/integration/api/observabilidad.spec.ts` (falla igual, porque `createApp` →
   rutas → `domain-hotel`). Por eso NO se pudo correr `npm run typecheck` completo ni
   la suite de integración de `apps/api` de extremo a extremo contra este cambio -- se
   verificó en su lugar (a) el job de purga de forma aislada contra embedded-postgres
   real (arriba, 4/4), (b) sintaxis de los 6 archivos tocados/nuevos con
   `esbuild --bundle=false` (todos OK) y (c) `eslint` sobre los mismos 6 archivos (0
   errores). Este hallazgo es AJENO al alcance de REQ-SEG-005/011/012 (no se intentó
   "arreglar" reconstruyendo 6 módulos de otro dominio) y se reporta explícitamente
   como bloqueador pre-existente, no inventado por este cambio ni causado por él.
2. Ninguna ruta real de `apps/api` llama todavía
   `PaymentProviderPort.preAuthorize()` (VCC) — solo `charge()` está conectado
   (`folios.ts`). El job purga correctamente cualquier fila `payment` que SÍ llegue a
   ese estado (vía integración futura o dato migrado), pero hasta que exista una ruta
   real de pre-autorización, la tabla no tendrá filas `autorizado` en producción. Esto
   no invalida el cierre de REQ-SEG-011 (el requisito es sobre la purga/expiración
   automática, que ahora existe, corre y está probada) pero se documenta para no
   sobreclamar un flujo de VCC de punta a punta que no existe.
