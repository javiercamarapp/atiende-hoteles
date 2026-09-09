# REQ-REV-007 — evidencia

P1/GOB: "parity guard" configurable por hotel que respeta la paridad contractual
vigente con OTAs (bloquea/alerta si una tarifa propuesta rompe la paridad pactada).

## Implementación

- `packages/domain-hotel/src/revenue/parity-guard.ts` (nuevo): módulo puro de dominio.
  - `ParityGuardConfig` por hotel: `mode` (`"bloquea" | "alerta"`) + lista de
    `ParityChannelConfig` (canal/OTA, tarifa de referencia, tolerancia pactada en %).
  - `evaluateParityGuard(config, proposedRate)`: evalúa la propuesta contra CADA canal
    configurado de forma independiente (romper la paridad con un solo canal ya cuenta),
    calcula el piso (`computeParityFloor`) y reporta violaciones con código +
    explicación en español.
  - Modo `"bloquea"`: `allowed=false` si hay alguna violación. Modo `"alerta"`: siempre
    `allowed=true`, pero reporta igual las violaciones para que quien llama decida
    notificar/registrar.
  - `assertValidParityChannelConfig` / `assertValidParityGuardConfig`: validan
    referencia > 0, tolerancia en [0,100), modo válido y sin canales duplicados por
    hotel.
- `packages/domain-hotel/src/index.ts`: exporta el nuevo módulo.
- `tests/unit/domain-hotel/parity-guard.spec.ts` (nuevo, 27 tests): valida
  configuración, cálculo del piso, frontera exacta (épsilon de punto flotante), modo
  bloquea vs. alerta, violación individual por canal y violaciones simultáneas contra
  varios canales.

Alcance deliberado: este módulo NO consulta la tarifa vigente en cada OTA (eso
requeriría el conector/channel manager de REQ-REV-008..011, fuera de fase por diseño
del repo) — recibe las tarifas de referencia ya obtenidas por quien llama y decide.

## Comandos y resultado

```
$ npx vitest run --config vitest.config.ts tests/unit/domain-hotel/parity-guard.spec.ts
✓ tests/unit/domain-hotel/parity-guard.spec.ts (27 tests)
Test Files  1 passed (1)
     Tests  27 passed (27)
```
Log completo: `vitest-parity-guard-unit.log`.

```
$ (cd packages/domain-hotel && npx tsc --noEmit -p tsconfig.json)
```
exit 0 — log: `typecheck-domain-hotel.log`.

```
$ (cd packages/domain-hotel && npx eslint src/revenue/parity-guard.ts)
```
exit 0 — log: `eslint-parity-guard.log`.

```
$ npx vitest run --config vitest.config.ts tests/unit/domain-hotel
Test Files  17 passed (17)
     Tests  209 passed (209)
```
(paquete `domain-hotel` completo, sin regresiones) — log: `vitest-domain-hotel-full.log`.

## Nota sobre el resto de la suite `test:unit`

Al correr `npm run test:unit` completo (todo `tests/unit/`, no solo domain-hotel) se
observaron 2 fallas intermitentes y NO reproducibles de forma estable, ambas en checks
que corren "contra el repo real" (git log real / `tasks/` real / `docs/logs/` real):
`tests/unit/gob/evidencia-obligatoria-cierre.spec.ts` y
`tests/unit/gob/cierre-tarea-conventional-commits.spec.ts`. Repetir exactamente el
mismo comando 3 veces seguidas produjo fallas DISTINTAS cada vez (a veces
`evidencia-obligatoria-cierre` falla y `cierre-tarea` pasa, a veces al revés, con
mensajes de violación distintos entre corridas) — comportamiento consistente con el
checkout compartido de este repo estando modificado en simultáneo por otros procesos/
sesiones (git log y `docs/logs/` cambiando bajo los pies del test mientras corre), el
mismo patrón de "race condition del checkout compartido" ya documentado en el commit
`0498526` de este repo. No están relacionadas con `parity-guard.ts` — no se tocó
`tasks/`, `docs/logs/gob`, ni el git log en este trabajo, y las 209 pruebas del paquete
`domain-hotel` (incluidas las 27 nuevas) pasan de forma consistente y determinista.
