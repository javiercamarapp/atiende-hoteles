# @atiende-hoteles/domain-hotel

Dominio puro (sin I/O, sin dependencia de Postgres/Hono) del módulo de reservas/tarifas
(H4, ADR-005): motor de cotización determinista, máquina de estados de reserva,
política de cancelación/depósito, sobreventa controlada y una guarda de benchmarking de
compset. Mismo patrón que `packages/db`/`packages/agent-core`: se importa el `.ts`
fuente directamente vía workspaces (`exports: { ".": "./src/index.ts" }`), sin paso de
build.

## Por qué existe

Estas reglas deben poder probarse con pruebas unitarias rápidas (sin `embedded-postgres`)
y deben ser la ÚNICA vía de cálculo de precio/estado — nunca un LLM decide, redondea o
inventa un precio o una transición (REQ-RES-002, REQ-REV-001). La base de datos
(`packages/db`) sigue siendo la autoridad final para todo lo que además tiene
consecuencias de concurrencia real (inventario, transición de estado): las funciones de
este paquete son un espejo explicado, testeable y explicable de esas mismas reglas, no
un sustituto de la validación en Postgres.

## Módulos

- **`quote.ts`** — `computeQuote()`: noches × tarifa real de `rate_plan` + impuestos
  (`taxes.ts`), validando min-stay/CTA/CTD. `parseQuoteInput()` usa un esquema `zod` que
  solo reconoce las columnas reales de `rate_plan`: cualquier campo extra (ej. un precio
  sugerido por un LLM de canal conversacional) se descarta antes de calcular nada.
- **`taxes.ts`** — `applyTaxes()`: aplica IVA/ISH como parámetros (`hotel_tax_config`),
  nunca como una tasa fiscal fija en código.
- **`reservationStateMachine.ts`** — espejo de
  `packages/db/migrations/0006_reservation.sql` (mismos 8 estados, mismas transiciones)
  más una tabla de qué rol puede ejecutar cada transición (capa de aplicación; la RLS de
  `packages/db` sigue siendo la autoridad irrenunciable).
- **`cancellationPolicy.ts`** — REQ-RES-004: política en 4 puntos (`free_until`,
  `penalty`, `no_show`, `deposit`), determinista.
- **`overbooking.ts`** — REQ-RES-007: espejo exacto de la fórmula de sobreventa de
  `book_availability` (0013) para explicarla/probarla sin DB.
- **`compsetGuard.ts`** — REQ-REV-004: guarda negativa (k≥10, ≥12 meses, opinión
  antimonopolio) — H4 no construye el motor de benchmarking en sí, solo esta guarda.

## Qué NO hace (fuera de alcance de H4, documentado — no fingido)

- No calcula probabilidad de no-show con clima/eventos (REQ-RES-009, P2).
- No ejecuta el cobro real de tarjeta ante un no-show (REQ-RES-008): requiere pasarela
  de pago, pendiente de credenciales (ver `docs/BLOQUEOS.md`).
- No implementa el motor de revenue management (propuesta/ejecución de tarifas por
  365 días, REQ-REV-002/003): `compsetGuard.ts` es solo la guarda negativa exigida por
  REQ-REV-004, no el motor completo.
