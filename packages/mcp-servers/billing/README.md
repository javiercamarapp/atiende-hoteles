# @atiende-hoteles/mcp-billing

`BillingProviderPort` con adaptadores intercambiables (Stripe Billing/Conekta
Suscripciones) para la **facturación SaaS del hotel** (Atiende cobrando AL HOTEL) --
hito **H12c**, LAUNCH-015 (`docs/referencia/08-inventario-punta-a-punta.md`). Distinto de
`@atiende-hoteles/mcp-payments`, que cobra al HUÉSPED: son dominios de negocio
independientes con ciclos de vida distintos (suscripción recurrente vs. cargo/pre-auth
puntual), por eso NO comparten puerto aunque el patrón de adaptador sea idéntico.

## Contrato (`src/port.ts`)

`createCheckoutSession` / `createPortalSession` / `verifyAndNormalizeWebhook`. Estado de
dominio de suscripción: `trial|activa|vencida|cancelada` (igual a
`public.subscription_status`, `packages/db/migrations/0110`).

## Adaptadores reales (`src/adapters/{stripe,conekta}-billing-adapter.ts`)

**[PENDIENTE DE CREDENCIALES]**. `StripeBillingAdapter` requiere `STRIPE_SECRET_KEY` +
`STRIPE_BILLING_WEBHOOK_SECRET` (secreto de webhook **distinto** del de
`mcp-payments`: en Stripe cada endpoint de webhook tiene su propio secreto, y el de
facturación SaaS vive en un endpoint separado del de cobros a huésped).
`ConektaBillingAdapter` requiere `CONEKTA_PRIVATE_KEY` + `CONEKTA_BILLING_WEBHOOK_SECRET`.
Sin credenciales, `status()` reporta `unavailable` y ningún método llama a la red real
(ningún checkout/portal falso se hace pasar por real).

## Adaptador simulado (`src/adapters/fake-billing-adapter.ts`)

`FakeBillingAdapter` (`simulated: true`) es el que `apps/api` instancia por defecto (ver
`apps/api/src/types.ts`/`app.ts`). Genera URLs de checkout/portal bajo el dominio
`billing.simulado.local` (nunca un dominio real de Stripe/Conekta) y firma/verifica
webhooks con HMAC (`signWebhookFixture`), usado en
`tests/adversarial/facturacion-saas.spec.ts` para la prueba "webhook con firma inválida
se rechaza" y "webhook repetido no se aplica dos veces".

## Idempotencia de webhooks (dos capas)

1. `InMemoryReplayGuard` dentro de cada adaptador (se pierde si el proceso reinicia).
2. `public.billing_webhook_event` (`packages/db/migrations/0112`,
   `claim_billing_webhook_event()`) -- PERSISTIDA, sobrevive un reinicio. La ruta
   `POST /webhooks/billing` (`apps/api/src/routes/suscripcion.ts`) llama primero al
   adaptador (verifica firma) y luego reclama el evento en Postgres antes de aplicar
   ningún efecto -- un webhook reenviado (entrega at-least-once, documentada por ambos
   proveedores) nunca actualiza dos veces la misma suscripción.

## Precios de plan -- PENDIENTE DE APROBACIÓN DEL FUNDADOR

Los 3 planes sembrados en `public.plan` (`packages/db/migrations/0110`, código
`starter`/`pro`/`enterprise`) tienen `es_propuesta = true` y precios derivados de los
benchmarks de H18 (Cloudbeds/Mews/Canary/HiJiffy/Duve/Asksuite) y del techo de costo de
LLM-026 (~USD 27-158/hotel/mes según opción de proveedor de modelo) -- **NO son una
decisión de precio de lista**: fijar precio de lista es una decisión reservada
exclusivamente al fundador (`REQ-GOB-012`, catálogo cerrado de decisiones reservadas).
Registrado en `docs/BLOQUEOS.md` D-006. Ningún código de este hito pone `es_propuesta =
false`.

El modelo híbrido completo de H18 (SaaS fijo + 3% sobre reservas directas incrementales +
25-35% del ahorro energético verificado + 10-15% de comisión en ancillaries, H18-003/004)
**no se implementa en este hito**: `invoice_saas` (0112) solo cubre el cargo fijo
recurrente del plan. El componente variable por resultado queda documentado como
pendiente (requiere la línea base firmada de REQ-GOB-016, fuera de alcance de H12c).

## PENDIENTE DE CREDENCIALES (checklist de salida a producción)

- [ ] Cuenta Stripe (modo live) + producto/precios de Stripe Billing configurados para
      `starter`/`pro` (Enterprise se cotiza fuera de Stripe) + `STRIPE_SECRET_KEY` +
      `STRIPE_BILLING_WEBHOOK_SECRET`.
- [ ] Cuenta Conekta (Suscripciones) + `CONEKTA_PRIVATE_KEY` +
      `CONEKTA_BILLING_WEBHOOK_SECRET`, si se decide ofrecer Conekta como alternativa MXN
      (H18 menciona Conekta como proveedor local preferido para PyMEs mexicanas).
- [ ] PAC de CFDI real conectado (`CfdiPort`, `packages/mcp-servers/cfdi`) para timbrar
      `invoice_saas` de verdad -- hoy usa el mismo `DualPacCfdiPort` fake que el resto del
      sistema (ver `apps/api/src/app.ts`).
- [ ] Decisión del fundador sobre precios de lista (D-006) antes de poner
      `es_propuesta = false` en cualquier fila de `plan`.
