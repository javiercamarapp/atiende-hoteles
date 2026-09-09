# REQ-SEG-005 — evidencia (2026-09-08)

Criterio (`docs/REQUISITOS.md`): "El sistema no debe almacenar el PAN completo de
tarjeta en ningún componente propio (tokenización obligatoria del PSP), reduciendo el
alcance PCI DSS a SAQ A/SAQ A-EP." Estado previo en la matriz: `pendiente-credenciales`
(depende de: pasarela).

## Verificación realizada

1. **Esquema de entrada (Zod)** — `apps/api/src/routes/folios.ts::paymentSchema` solo
   acepta `tokenPago` (string opaco) para pagos con tarjeta; la ruta rechaza
   explícitamente (`Errors.validation`) un pago con tarjeta sin `tokenPago`. Ningún
   campo del esquema se llama `numeroTarjeta`/`cardNumber`/`pan`/`cvv`.
2. **Contrato del PSP** — `packages/mcp-servers/payments/src/port.ts::ChargeInput`
   exige `paymentMethodToken` (nunca un PAN); los adaptadores reales
   (`stripe-adapter.ts`, `conekta-adapter.ts`) y el falso (`fake-payment-adapter.ts`)
   implementan el mismo puerto.
3. **Constraint de base de datos** (última línea de defensa, no la única) —
   `packages/db/migrations/0030_folio_engine.sql`:
   `alter table public.payment add constraint payment_token_ref_not_pan check
   (token_ref is null or token_ref !~ '^[0-9]{12,19}$');` — un INSERT/UPDATE que
   intente guardar una cadena de 12-19 dígitos (forma de un PAN) en `token_ref` es
   rechazado por Postgres, incluso si algún código de aplicación futuro lo intentara.
4. **Chequeo estático existente** `scripts/checks/no-pan-storage.ts` (ya en el repo,
   REQ-REC-008/H19-005) — al ejecutarlo se encontraron 2 FALSOS POSITIVOS reales (ver
   `docs/logs/REQ-SEG-005/no-pan-storage-20260908-225950.log` para la salida ANTES del
   fix, capturada por separado en la sesión): `apps/api/src/logger.ts` (lista de
   REDACCIÓN de logs que incluye `"cvv"` — protección, no almacenamiento) y
   `apps/api/src/routes/mensajeria.ts` (`pago.containsCardNumber`, un booleano de
   DETECCIÓN ya redactada, no un campo de almacenamiento). Corregido en
   `scripts/checks/no-pan-storage.ts` (allowlist de archivo + exclusión por contexto
   `contains`/`detect`/`has`/`is`), verificado que el check sigue detectando una
   inyección real de prueba (`card_number: "leaked"` → `exit 1`) antes de confirmar el
   0 final.

## Salida real (después del fix)

```
$ node scripts/checks/no-pan-storage.ts
REQ-REC-008 OK: 0 columnas/campos de PAN/CVV en packages/db/migrations ni apps/api/src -- todo cobro usa token del PSP.
```
Log completo: `docs/logs/REQ-SEG-005/no-pan-storage-20260908-225950.log`.

## Qué NO se cerró (honesto)

No existe todavía ninguna ruta de `apps/api` que use `PaymentProviderPort.preAuthorize()`
(solo `charge()` está conectado, ver `folios.ts`) ni credenciales reales de
Stripe MX/Conekta — el adaptador real nunca se ha ejecutado contra el PSP de verdad.
Por eso la fila se mantiene `pendiente-credenciales` (no se reclasifica a `hecho`): lo
verificable sin credenciales (esquema de entrada, contrato del puerto, constraint de
BD, chequeo estático) está confirmado y ahora sin falsos positivos; la certificación
PCI SAQ A/SAQ A-EP en sí depende de una integración real con el PSP, fuera del alcance
de este cambio.
