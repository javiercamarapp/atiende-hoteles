# Nota: errores de typecheck preexistentes, ajenos a REQ-HUE-009

`typecheck-api-full-20260908-181706.log` (exit 2) y `typecheck-root-full-20260908-181706.log`
(exit 2) traen errores preexistentes de trabajo no comiteado de OTROS requisitos que ya
estaban en el working tree al empezar esta tarea (`apps/api/src/pms/fraudScan.ts`,
`apps/api/src/routes/fraude.ts`, `apps/api/src/routes/pedidosFnb.ts`,
`tests/unit/domain-hotel/{fnb-allergy-guard,fraude-deteccion,parity-guard,
pronostico-series-tiempo,revenue-engine-gate,walk-forward-backtest}.spec.ts`, etc.) —
todos por exports de `@atiende-hoteles/domain-hotel` que esos módulos (fraude, F&B/alergias,
revenue-engine-gate, pronóstico) todavía no cablean en `packages/domain-hotel/src/index.ts`.

Verificado con `grep -i "voiceGuardrails\|voz-guardrails\|agentes.ts"` sobre ambos logs: **0
coincidencias** — ninguno de los archivos que esta tarea creó o modificó
(`packages/domain-hotel/src/voiceGuardrails.ts`, el bloque agregado a
`packages/domain-hotel/src/index.ts`, `apps/api/src/routes/agentes.ts`,
`tests/unit/domain-hotel/voice-guardrails.spec.ts`,
`tests/adversarial/voz-guardrails.spec.ts`) aparece en ninguno de los dos logs.

No se tocó ninguno de esos archivos ajenos: pertenecen a trabajo en curso de otros
requisitos (REQ-AB-004, fraude/REQ-REC-014, REQ-REV-003/007, etc.), fuera del alcance de
este encargo.
