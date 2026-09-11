# REQ-REV-019 — evidencia de cierre

Fecha: 2026-09-11 (UTC, ver timestamps de los logs).

Criterio de aceptación literal (docs/ACEPTACION.md §3.7): "Precio de venta con techo
≤20-30% del valor conservador deduplicado, descuentos por tamaño/ADR, y factor de
deduplicación cuando ≥2 agentes con valor solapado se activan juntos (verificado con
caso de solape sintético)." Tipo de prueba: `unit`. Depende de credenciales: `No`.

## Comandos ejecutados y resultado real

1. `npx vitest run tests/unit/domain-hotel/pricing-techo-roi.spec.ts` → **22/22 tests
   en verde**, exit 0. Log: `pricing-techo-roi-20260911-071356.log`. Incluye dos casos de
   solape sintético (H17-005: grupo `captura_directa` = voz+WhatsApp+directo; grupo
   `tarifa_realizada` = RM+reputación+CRM) y el caso negativo explícito
   ("caso negativo: un precio que excede el techo ... se bloquea con la razón
   `precio_excede_techo`").
2. `npx tsc --noEmit -p tsconfig.json` → sin errores, exit 0. Log:
   `typecheck-20260911-071356.log` (vacío = sin diagnósticos).
3. `npx eslint packages/domain-hotel/src/revenue/pricingTechoRoi.ts packages/domain-hotel/src/index.ts tests/unit/domain-hotel/pricing-techo-roi.spec.ts`
   → sin hallazgos, exit 0. Log: `eslint-20260911-071356.log` (vacío = sin hallazgos).
4. `npx vitest run tests/unit/domain-hotel` (suite completa del paquete, para descartar
   regresión) → **509/509 tests en verde**, 35 archivos, exit 0 (corrida interactiva, sin
   log aparte — ver transcript de la sesión).

## Qué NO aplica a este REQ (y por qué)

- **Migración de BD**: ninguna. El propio `docs/ACEPTACION.md` declara REQ-REV-019 como
  tipo de prueba `unit` y "Depende de credenciales: No" — es una regla de negocio pura,
  calibrada a mano en el precio de lista de los planes (BP-149: "Vende"/"Opera"), no una
  tabla ni un cálculo por transacción en producción. `npm run check:migraciones` no
  aplica (no se creó ninguna migración) y no se corrió por no haber cambio a
  `packages/db/migrations/`.
- **Ruta API**: ninguna. Mismo razonamiento — no hay endpoint que recalcule esto en vivo
  hoy; es una función de dominio pura que otra capa (calculadora de ROI, panel de ventas)
  puede invocar cuando exista.
- **Pruebas de integración/adversariales**: no aplica — sin I/O, sin identidad, sin
  fraude involucrado en este REQ puntual (P2/GOB, no P0 de seguridad).

## Archivos

- `packages/domain-hotel/src/revenue/pricingTechoRoi.ts` (módulo de dominio puro)
- `packages/domain-hotel/src/index.ts` (exports agregados)
- `tests/unit/domain-hotel/pricing-techo-roi.spec.ts` (22 tests, incluye caso de solape
  sintético y caso negativo)
