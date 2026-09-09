# REQ-REV-018 — evidencia (2026-09-08)

Criterio (`docs/ACEPTACION.md`): línea base firmada en semana 1 registrada por
agente/módulo con impacto económico; eventos con `monto_verificado`, `monto_estimado`,
`metodo_contrafactual`, `confianza`; ningún cobro por resultado se activa sin línea base
firmada (verificado: intento de cobro sin línea base → bloqueado). Compartido con
REQ-GOB-016 (mismo criterio literal, ver `docs/REQUISITOS.md`/`docs/ACEPTACION.md`).

## Estado real encontrado al llegar

La captura de eventos (`roi_event`: `monto_verificado`/`monto_estimado`/
`metodo_contrafactual`/`confianza`, migración 0026) ya existía de REQ-AGT-003 (H7). El
propio archivo de esa migración y `packages/db/README.md` documentaban explícitamente el
gap exacto de este requisito: *"la lógica de 'línea base firmada' que exige REQ-REV-018
para activar un cobro por resultado sobre estos eventos queda pendiente de un hito
posterior"*. Confirmado con `grep -rniE "linea_base|baseline"` en `packages/`/`apps/`:
0 tablas, 0 lógica real, solo esa nota.

## Cambio: dos tablas + dos triggers (autoridad real en Postgres, no en la aplicación)

`packages/db/migrations/0112_roi_baseline_cobro_resultado.sql` — mismo patrón que
`0082_revenue_engine_gate.sql` (máquina de estados real por trigger):

1. **`roi_baseline`**: línea base por `(hotel_id, agent_name)` — `metrica`/`valor_base`/
   `unidad`/`metodo_captura`/`periodo_desde`/`periodo_hasta` (catálogo de `agent_name`
   abierto, mismo criterio que `roi_event.tipo_evento`). `activado_en` marca el inicio
   del reloj de "semana 1"; `firmado_en`/`firmado_por` quedan NULL mientras sigue en
   borrador. El trigger `roi_baseline_guard()`:
   - Rechaza firmar (`linea_base_fuera_de_semana_1`) más de 7 días después de
     `activado_en`.
   - Rechaza firmar (`firma_anterior_a_activacion`) antes de la propia activación.
   - Rechaza cambiar cualquier otro campo en el MISMO `UPDATE` que firma
     (`no_se_puede_modificar_al_firmar`).
   - Hace la fila COMPLETAMENTE INMUTABLE una vez firmada
     (`linea_base_firmada_inmutable`) — append-only, mismo criterio que
     `roi_event`/`audit_log`.
2. **`cobro_resultado_activacion`**: el punto de activación real de un cobro por
   resultado (`roi_baseline_id` como referencia real, `modelo_cobro` texto libre). El
   trigger `cobro_resultado_activacion_guard()` es el GATE del criterio literal:
   - `linea_base_no_encontrada` si el id no existe.
   - `linea_base_no_corresponde` si la línea base es de otro hotel/agente.
   - `linea_base_no_firmada` si la línea base existe pero sigue en borrador.
   - `aprobacion_fundador_requerida` (defensa en profundidad, BP-150/GOB-052: "todo
     cambio de ... estructura de éxito compartido por hotel requiere decisión reservada
     al fundador") si no hay una aprobación vigente para
     `estructura_de_exito_compartido` (catálogo cerrado ya existente de 0081) — mismo
     patrón exacto que `0082` exige `shadow_a_autopilot_revenue` antes de autopilot.

RLS en ambas tablas: SELECT abierto a todo el staff del hotel (transparencia, mismo
criterio que `roi_event`/`agent_config`); INSERT/UPDATE reservado a owner/gm.

## Bug real encontrado y corregido por la propia prueba en rojo

Primera versión: `new.firmado_en < new.activado_en` sin truncar precisión.
`activado_en` usa por default `now()` de Postgres (microsegundos) mientras `firmado_en`
normalmente llega como un `Date` de JavaScript (milisegundos) — firmar en el MISMO
instante de crear el borrador podía leerse como "unos microsegundos antes de la
activación" y rechazarse por un artefacto de precisión, no por una violación real de la
regla. Corregido comparando `date_trunc('milliseconds', ...)` en ambos lados de las dos
comparaciones (INSERT y UPDATE). Verificado corriendo la prueba 4 veces seguidas tras el
fix, sin flakiness.

## Espejo puro en domain-hotel

`packages/domain-hotel/src/roi/roiBaseline.ts` (mismo principio de separación que
`revenueEngineGate.ts`: sin acceso a BD, determinista): `BASELINE_SIGNING_WINDOW_DAYS`
(=7), `assertBaselineSignableWithinWeek1`, `evaluateCobroPorResultadoActivation` —
documentado explícitamente que este espejo NO valida la aprobación del fundador (esa
condición solo la puede evaluar la base de datos). Exportado desde
`packages/domain-hotel/src/index.ts` — mi bloque es puramente ADITIVO al final del
archivo (ver "fuera de alcance" abajo).

## Pruebas nuevas

- `tests/adversarial/roi-sin-linea-base.spec.ts` (12 pruebas, contra `embedded-postgres`
  real, ADR-003, sin mocks): sin ninguna línea base (id inexistente) → bloqueado, incluso
  con aprobación del fundador ya registrada; línea base en borrador → bloqueado; línea
  base firmada FUERA de semana 1 (intento de firmar 10 días después de activada) → la
  firma misma se rechaza, sigue sin firmar, la activación sigue bloqueada; firmar ANTES
  de la activación → rechazado; línea base firmada pero SIN aprobación del fundador (org
  y hotel independientes, para que la ausencia sea real y no un efecto del orden de los
  tests) → bloqueado; línea base firmada INMUTABLE (ni owner/gm puede reescribir el
  monto ya mostrado); no se puede cambiar otro campo en el mismo `UPDATE` que firma; RLS
  — frontdesk no puede crear/firmar (pero sí leer, transparencia) ni activar; gm tiene el
  mismo nivel que owner; CASO POSITIVO — línea base firmada a tiempo + aprobación del
  fundador → SÍ se activa (el gate discrimina de verdad, no solo deniega siempre) y no
  se puede activar dos veces el mismo hotel/agente (unique); línea base de OTRO agente
  (aunque firmada) no habilita este agente.
- `tests/unit/domain-hotel/roi-baseline.spec.ts` (10 pruebas, espejo puro de la ventana
  de semana 1 y del gate de activación, sin BD).

## Comandos y evidencia

- `npx vitest run tests/adversarial/roi-sin-linea-base.spec.ts` → 12/12 verde, repetido 4
  veces seguidas sin flakiness (`vitest-adversarial-roi-sin-linea-base-20260908-184537.log`).
- `npx vitest run tests/unit/domain-hotel/roi-baseline.spec.ts` → 10/10 verde
  (`vitest-unit-roi-baseline-20260908-184537.log`).
- `npx vitest run tests/integration/agent-core/roi-event-cobertura.spec.ts tests/unit/agent-core/roi-tools.spec.ts tests/adversarial/decisiones-reservadas-fundador.spec.ts --pool=forks --poolOptions.forks.singleFork`
  → 3 archivos/16 pruebas verdes, sin regresión sobre el mecanismo de `roi_event` ni
  sobre el catálogo cerrado de decisiones reservadas del fundador
  (`vitest-regresion-roi-fundador-20260908-184537.log`).
- `node scripts/check-migraciones.ts` → OK, 73 migraciones verificadas, 0 destructivo sin
  aprobar (`check-migraciones-20260908-184537.log`). Nota: una corrida ANTERIOR (antes de
  crear mi migración) reportó una colisión de numeración preexistente y ajena entre
  `0111_guardrails_conversacionales.sql`/`0116_marketing_template_linter.sql` (dos
  sesiones concurrentes); esa colisión desapareció sola entre mis dos corridas (otra
  sesión renumeró su archivo) — mi migración 0112 nunca colisionó con nada.
- `npm run typecheck --workspace=@atiende-hoteles/domain-hotel` → 0 errores
  (`typecheck-domain-hotel-20260908-184537.log`).
- `npx eslint packages/domain-hotel/src/roi/roiBaseline.ts packages/domain-hotel/src/index.ts tests/unit/domain-hotel/roi-baseline.spec.ts tests/adversarial/roi-sin-linea-base.spec.ts`
  → 0 errores, 0 warnings (`eslint-20260908-184537.log`, vacío = limpio).
- `npx vitest run tests/unit/domain-hotel` (suite completa del paquete) →
  `vitest-unit-domain-hotel-full-20260908-184537.log`: 23 archivos/274 pruebas verdes, 6
  archivos/121 pruebas preexistentes en rojo (`fnb-allergy-guard`, `fraude-deteccion`,
  `parity-guard`, `revenue-engine-gate`, `walk-forward-backtest`), **ninguna causada por
  este cambio** — ver siguiente sección.

## Fallas preexistentes confirmadas como AJENAS a este cambio

Las 6 suites en rojo fallan todas con el mismo patrón (`TypeError: (0 , <símbolo>) is
not a function` / `is not exported`): sus módulos fuente (`fnbAllergyGuard.ts`,
`fraude/deteccion.ts`, `revenue/parity-guard.ts`, `revenue/revenueEngineGate.ts`,
`revenue/walkForwardBacktest.ts`) existen en disco pero **nunca fueron exportados** desde
`packages/domain-hotel/src/index.ts` — trabajo de otras 5 sesiones concurrentes en este
mismo working tree compartido, sin commitear, cuya edición del barril se perdió en la
carrera de ediciones simultáneas sobre el mismo archivo.

Verificado que esto es ajeno a mi cambio, no una regresión mía:

1. `git diff -- packages/domain-hotel/src/index.ts` (ver arriba/en el working tree):
   TODO mi cambio en ese archivo es un bloque `export { ... } from "./roi/roiBaseline.ts";`
   añadido al FINAL — nunca toqué ni eliminé una línea existente.
2. `git show HEAD:packages/domain-hotel/src/index.ts | grep -c "fnbAllergyGuard\|revenueEngineGate\|walkForwardBacktest\|parity-guard"`
   → 0. Esos símbolos tampoco estaban exportados en el último commit real de `main`, así
   que el gap es anterior a toda esta ronda de trabajo concurrente, no algo que yo haya
   introducido ni siquiera indirectamente.
3. `docs/logs/REQ-AGT-003/NOTA.md` (de otra sesión, mismo día 2026-09-08) ya documenta
   independientemente "122 fallas preexistentes ajenas (todas en
   `tests/unit/domain-hotel/*`)" — mismo conteo del mismo origen, confirmado por una
   sesión distinta.

No se tocó ninguno de esos módulos ni su exportación — no es mi alcance corregir el
export de otro frente en curso.

## Fuera de alcance de este encargo (declarado explícitamente)

- El motor de FACTURACIÓN/cobro real (cálculo periódico de la cuota, generación del
  cargo) sobre una `cobro_resultado_activacion` ya habilitada NO se construyó — este
  requisito exige literalmente el GATE de activación ("ningún cobro por resultado se
  activa sin línea base firmada"), no el motor de cobro en sí. `roi_baseline.valor_base`
  y los `roi_event.monto_verificado` posteriores a `cobro_resultado_activacion.activado_en`
  quedan como los dos insumos listos para ese motor futuro.
- No se tocó ningún trabajo previo no comiteado de otros frentes encontrado en el
  working tree al llegar (fraude, F&B/alergias, revenue-engine-gate, parity-guard,
  pronóstico de series de tiempo, checador de asistencia, reputación/CRM, tickets/SLA,
  P&L USALI, guardrails de voz, redacción de PII en trazas, marketing template linter,
  `reporteMensualDueno.ts` de REQ-OBS-007 —que cita explícitamente a REQ-REV-018 como su
  dependencia pendiente para la agregación real, dejado intacto sin corregir su nota por
  no ser mi alcance—, `schema.sql`, `.gitleaks.toml`, `scripts/checks/*.ts` nuevos, etc.)
  — todos revisados y dejados intactos.
- No se tocó `docs/cierre-p0/inventario.md` (no tiene fila propia para REQ-REV-018).
