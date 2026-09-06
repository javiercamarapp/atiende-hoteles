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

**[PENDIENTE DE CREDENCIALES]**. `StripeAdapter` requiere `STRIPE_SECRET_KEY` +
`STRIPE_WEBHOOK_SECRET` (verifica `Stripe-Signature: t=...,v1=...` sobre
`${timestamp}.${rawBody}`). `ConektaAdapter` requiere `CONEKTA_PRIVATE_KEY` +
`CONEKTA_WEBHOOK_SECRET`. Ambos incluyen reintentos con backoff ante `429`; sin
credenciales, `status()` reporta `unavailable` y ningún método llama a la red real.

## Adaptadores simulados (`src/adapters/fake-payment-adapter.ts`)

`FakeStripeAdapter` y `FakeConektaAdapter` (`simulated: true`) heredan de
`FakeGenericPaymentAdapter`: la MISMA máquina de estados/idempotencia/expiración de
pre-auth para ambos -- es la prueba viva de REQ-INT-002 ("cambiar de proveedor no
requiere tocar la lógica de negocio"): la suite de contrato corre línea por línea contra
los dos.

## Pruebas

`tests/unit/mcp-servers/payments/adapter-swap.spec.ts` corre la misma batería contra
`FakeStripeAdapter` y `FakeConektaAdapter`; contra los adaptadores reales solo si hay
credenciales.

## Estado

**[PENDIENTE DE CREDENCIALES]** -- REQ-INT-002 cubierto parcialmente: contrato,
intercambiabilidad y adaptadores simulados verificados; adaptadores reales pendientes
de cuentas Stripe/Conekta.
