# @atiende-hoteles/mcp-payments

`PaymentProviderPort` con adaptadores intercambiables (Stripe MX/Conekta, H15-007).
Cubre REQ-INT-002 (P0). Hito **H9**. Ver `docs/ARQUITECTURA.md` ADR-007.

## Contrato (`src/port.ts`)

`charge` / `preAuthorize` / `capturePreAuth` / `refund` / `verifyAndNormalizeWebhook`,
todos idempotentes por `idempotencyKey`. Estado de dominio:
`pendiente|autorizado|capturado|fallido|reembolsado|expirado`.

Mitigación de riesgo documentada en H15 ("cobro erróneo de VCC/pre-auth vencida"):
`PaymentResult.preAuthExpiresAt` es parte del contrato, y `capturePreAuth` lanza
`PreAuthExpiredError` si ya venció -- nunca captura silenciosamente una pre-auth vieja.

| Dominio | Stripe PaymentIntent | Conekta order |
|---|---|---|
| `pendiente` | `requires_payment_method/confirmation/action`, `processing` | `pending_payment` |
| `autorizado` | `requires_capture` | *(Conekta no separa pre-auth explícita en este mapeo)* |
| `capturado` | `succeeded` | `paid` |
| `fallido` | `canceled` | `declined` |
| `reembolsado` | — | `refunded`, `partially_refunded` |
| `expirado` | — | `expired` |

## Adaptadores reales (`src/adapters/{stripe,conekta}-adapter.ts`)

Ambos hacen llamadas HTTP reales (fetch nativo, sin SDK) contra la API pública
documentada de cada proveedor cuando hay credenciales -- `StripeAdapter` requiere
`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (autenticación `Bearer`, `Idempotency-Key`
por request, verifica `Stripe-Signature: t=...,v1=...` sobre `${timestamp}.${rawBody}`).
`ConektaAdapter` requiere `CONEKTA_PRIVATE_KEY` + `CONEKTA_WEBHOOK_SECRET`
(autenticación `Bearer`, cabecera `Accept: application/vnd.conekta-v2.3.0+json`).
Ambos incluyen reintentos con backoff ante `429` y timeout por request
(`requestTimeoutMs`, default 10s); sin credenciales, `status()` reporta `unavailable` y
ningún método llama a la red real.

### `verificadoContraReal = false` -- qué significa exactamente

Ambos adaptadores exponen `verificadoContraReal` (propiedad de instancia) y
`STRIPE_VERIFICADO_CONTRA_REAL`/`CONEKTA_VERIFICADO_CONTRA_REAL` (constantes de módulo),
siempre `false`. El código SÍ hace la llamada HTTP real siguiendo el contrato público
documentado de cada proveedor, y SÍ se probó de extremo a extremo contra un simulador
HTTP local (`tests/support/fakeStripeServer.ts`/`fakeConektaServer.ts`, servidores
`node:http` reales en 127.0.0.1 que imitan ese mismo contrato -- creación/confirmación,
captura, reembolso, tarjeta rechazada, timeout, respuesta malformada). Lo que NUNCA
ocurrió en esta sesión: una sola llamada contra `api.stripe.com`/`api.conekta.io` con
una cuenta real. Que la suite de contrato esté en verde demuestra que el ADAPTADOR
cumple el contrato documentado, no que Stripe/Conekta reales se comporten exactamente
así -- no asumas lo contrario.

### Credenciales necesarias para la primera prueba real

**Stripe (modo sandbox/test):**
1. Cuenta en [dashboard.stripe.com](https://dashboard.stripe.com) (gratis, sin cargos en modo test).
2. "Developers" → "API keys" → copiar la **Secret key** de modo Test (`sk_test_...`) → `STRIPE_SECRET_KEY`.
3. "Developers" → "Webhooks" → crear un endpoint (o usar `stripe listen` del Stripe CLI) → copiar el **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.
4. Usar un [token de tarjeta de prueba](https://docs.stripe.com/testing) (p. ej. `pm_card_visa`) como `paymentMethodToken` -- nunca un PAN real.
5. Primer smoke test recomendado: `charge()` con `pm_card_visa` (debe quedar `capturado`) y con `pm_card_visaChargeDeclined` (debe quedar `fallido`, no lanzar).

**Conekta (modo sandbox/test):**
1. Cuenta en [panel.conekta.com](https://panel.conekta.com) (gratis, modo test sin cargos).
2. "Llaves API" → copiar la **llave privada** de modo Sandbox (`key_...`) → `CONEKTA_PRIVATE_KEY`.
3. "Webhooks" → crear una llave de webhook → `CONEKTA_WEBHOOK_SECRET` (nota: la verificación de webhook de Conekta en este adaptador reusa el verificador HMAC genérico del repo -- Conekta documenta un mecanismo de `webhook_keys` propio que NO se verificó contra un webhook real en esta sesión; tratar como pendiente igual que el resto).
4. Usar un [token de tarjeta de prueba](https://developers.conekta.com/docs/servicios-tarjetas) del Cards Test Kit como `paymentMethodToken`.
5. Antes de la primera prueba real, revisar los dos huecos de contrato documentados en la cabecera de `conekta-adapter.ts` (`customer_info`/`line_items` sintetizados con datos de reserva, no del huésped real) -- decidir si eso es aceptable para el piloto o si primero hay que extender `ChargeInput`.

### Idempotencia: Stripe vs. Conekta (asimetría real, documentada)

Stripe documenta y soporta la cabecera `Idempotency-Key` a nivel de API (garantía del
lado del proveedor). La documentación pública de Conekta consultada en esta sesión NO
documenta un mecanismo equivalente -- `ConektaAdapter` compensa con una salvaguarda
LOCAL (`InMemoryIdempotencyStore`, en memoria por proceso): evita doble-cobro dentro del
mismo proceso, pero NO es una garantía del lado de Conekta (dos procesos distintos, o un
reinicio, con la misma `idempotencyKey` SÍ podrían crear dos órdenes reales). Antes de
un piloto con Conekta, confirmar con soporte de Conekta si existe un mecanismo de
idempotencia real a nivel de API que no se haya encontrado en esta investigación.

## Adaptadores simulados (`src/adapters/fake-payment-adapter.ts`)

`FakeStripeAdapter` y `FakeConektaAdapter` (`simulated: true`) heredan de
`FakeGenericPaymentAdapter`: la MISMA máquina de estados/idempotencia/expiración de
pre-auth para ambos -- es la prueba viva de REQ-INT-002 ("cambiar de proveedor no
requiere tocar la lógica de negocio"): la suite de contrato corre línea por línea contra
los dos.

## Simuladores HTTP locales de contrato (`tests/support/fake{Stripe,Conekta}Server.ts`)

Servidores `node:http` reales (mismo patrón que `tests/support/fakeGoogleOAuth.ts`) que
imitan las rutas y formas de respuesta REALES de cada proveedor (PaymentIntents/Refunds
de Stripe; Orders de Conekta), con tokens mágicos (`TEST_CARD_TOKENS`) para forzar
camino feliz / tarjeta rechazada / timeout / respuesta malformada de forma determinista.
`StripeAdapter`/`ConektaAdapter` les hacen fetch REAL (vía `apiBase` inyectable en el
constructor) -- estas pruebas ejercitan el código del adaptador de punta a punta, sin
mockear `fetch`.

## `resolvePaymentPort()` (`apps/api/src/lib/resolvePaymentPort.ts`)

Elige el adaptador real según qué credenciales existan en el proceso (`STRIPE_SECRET_KEY`
→ `StripeAdapter`; si no, `CONEKTA_PRIVATE_KEY` → `ConektaAdapter`; si no,
`FakeStripeAdapter`), mismo patrón que `resolveEmailPort()`
(`apps/api/src/emailOutbox/runEmailOutboxWorker.ts`). `apps/api/src/server.ts` (arranque
real) lo llama y pasa el resultado a `AppDeps.payments`; `createApp()` sigue usando
`FakeStripeAdapter` como default solo cuando nadie pasa `deps.payments` (pruebas).

## Pruebas

- `tests/unit/mcp-servers/payments/adapter-swap.spec.ts` -- contrato de negocio
  (idempotencia, pre-auth/expiración, refund) contra `FakeStripeAdapter`/
  `FakeConektaAdapter`; smoke test de que los adaptadores reales sin credenciales
  declaran `unavailable` y lanzan `PortUnavailableError` en vez de fingir.
- `tests/integration/contracts/payments/{stripe,conekta}-adapter.spec.ts` -- contrato
  HTTP real de `StripeAdapter`/`ConektaAdapter` contra los simuladores locales de arriba:
  camino feliz, tarjeta rechazada, timeout, respuesta malformada, pre-auth vencida.

## Estado

**Adaptadores reales implementados y probados contra un simulador de contrato local,
[PENDIENTE DE VERIFICACIÓN CONTRA EL PROVEEDOR REAL]** -- REQ-INT-002 cubierto:
contrato, intercambiabilidad, adaptadores simulados Y adaptadores reales (código +
pruebas de contrato) verificados; falta únicamente ejecutar la primera llamada real con
credenciales de sandbox (ver sección de credenciales arriba) -- hasta entonces,
`verificadoContraReal` sigue en `false` y así debe reportarse.
