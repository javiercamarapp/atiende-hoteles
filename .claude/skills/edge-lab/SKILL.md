---
name: edge-lab
description: Laboratorio de escenarios de frontera/adversariales contra los módulos de dominio puros del hotel (folio, alergias F&B, gate de revenue) -- corre en segundos y afirma el resultado esperado de cada frontera de negocio conocida. Úsala antes de tocar folioEngine.ts, fnbAllergyGuard.ts o revenueEngineGate.ts, o cuando quieras una comprobación rápida de que las reglas de negocio críticas siguen aguantando sin levantar toda la suite de Vitest.
---

# edge-lab

CLI real (`scripts/skills/edge-lab.ts`, REQ-AGT-021/BP-138) que ejercita 15 escenarios
de frontera/adversariales contra tres módulos de dominio puros ya existentes:

- `packages/domain-hotel/src/folioEngine.ts` -- tolerancia exacta de redondeo al cerrar
  folio, cargo negativo rechazado, propina nunca gravada, frontera exacta del umbral de
  descuento, y el caso central de identidad: una discrepancia activa de apellido/teléfono
  NUNCA es overridable por un rol administrativo (distinto de la simple ausencia de
  reclamo, que sí lo es).
- `packages/domain-hotel/src/fnbAllergyGuard.ts` -- la red de seguridad de texto libre no
  reconocido (nota que no calza el regex de alergia pero tampoco está vacía -> se trata
  como declarada), y que sin confirmación de cocina jamás se puede asegurar el platillo.
- `packages/domain-hotel/src/revenue/revenueEngineGate.ts` -- salto directo
  shadow->autopilot bloqueado, frontera exacta de variación de precio (15% permitido,
  15.1% rechazado), democión siempre permitida sin contexto (freno de emergencia).

No sustituye `tests/unit/domain-hotel/*.spec.ts` (cobertura amplia con Vitest); es la
herramienta rápida para "¿sigue aguantando esta frontera de negocio?" sin levantar toda
la suite.

## Cuándo usarla

- Antes de modificar cualquiera de los tres módulos de arriba.
- Al revisar un PR que los toca, como comprobación rápida adicional a la suite normal.
- Para agregar un escenario de frontera nuevo cuando una auditoría encuentre uno: se
  agrega una entrada al arreglo `SCENARIOS` exportado de `scripts/skills/edge-lab.ts`.

## Uso

```bash
node --experimental-strip-types scripts/skills/edge-lab.ts
```

Imprime `[PASS]`/`[FAIL]` por escenario y sale con código 1 si alguno falla.

## Comando de verificación

El mismo de arriba -- puro, determinista, sin I/O, sin red:

```bash
node --experimental-strip-types scripts/skills/edge-lab.ts
```
