---
name: revenue-backtest
description: Corre un backtest walk-forward del motor de revenue desde línea de comandos, dado un archivo JSON con la serie de fechas, el windowSpec y el ingreso YA CALCULADO del motor y del baseline por ventana -- envuelve el módulo de dominio puro walkForwardBacktest.ts (REQ-REV-003). Úsala para evaluar si un hotel en modo "propone" ya demuestra mejora suficiente vs. baseline antes de pedir la aprobación del fundador para pasar a "autopilot".
---

# revenue-backtest

CLI real (`scripts/skills/revenue-backtest.ts`, REQ-AGT-021/BP-138) que envuelve
`packages/domain-hotel/src/revenue/walkForwardBacktest.ts` (REQ-REV-003: "backtesting
walk-forward obligatorio que exija mejora vs. baseline antes de habilitar autopilot").

El script arma las ventanas walk-forward reales con `buildWalkForwardWindows` (sin fuga
de datos: cada ventana de prueba solo usa historia anterior a sí misma) y las combina
con el ingreso del motor y del baseline por ventana, YA CALCULADO por fuera con un
método contrafactual declarado (`misma_tarifa_periodo_anterior`,
`tarifa_estatica_pre_motor`, o `modelo_elasticidad_declarado` -- ver el docstring de
`walkForwardBacktest.ts` sobre por qué este módulo nunca inventa un ingreso
contrafactual él mismo). Con eso, `evaluateWalkForwardBacktest` adjudica pass/fail
según el criterio fijo de REQ-REV-003 (mínimo de ventanas, mejora agregada, mayoría de
ventanas ganadas).

## Formato de entrada (JSON)

```json
{
  "series": { "startDate": "2026-01-01", "endDate": "2026-06-30" },
  "windowSpec": { "trainDays": 60, "testDays": 14, "stepDays": 14 },
  "counterfactualMethod": "misma_tarifa_periodo_anterior",
  "windowRevenues": [{ "engineRevenue": 118500, "baselineRevenue": 110000 }, "... una entrada por ventana que produce series+windowSpec, en orden ..."],
  "minWindows": 3,
  "minImprovementPct": 0,
  "minWindowWinRatio": 0.5
}
```

`windowRevenues` debe traer exactamente tantas entradas como ventanas produce
`series`+`windowSpec` (el script valida esto y falla explícito si no coinciden).

## Uso

```bash
# Contra un archivo real de un hotel:
node --experimental-strip-types scripts/skills/revenue-backtest.ts ruta/a/datos.json

# Sin argumento, usa el dataset de ejemplo committeado (sintético, marcado como tal):
node --experimental-strip-types scripts/skills/revenue-backtest.ts
```

Código de salida 0 si el backtest se pudo CALCULAR (sin importar si `passes` da
`true` o `false` -- eso es un resultado de negocio, no un error del script); distinto de
cero solo si el archivo de entrada es inválido.

## Comando de verificación

Contra el dataset de ejemplo committeado (`scripts/skills/fixtures/revenue-backtest-sample.json`,
explícitamente sintético) -- determinista, sin red, sin efectos secundarios:

```bash
node --experimental-strip-types scripts/skills/revenue-backtest.ts
```
