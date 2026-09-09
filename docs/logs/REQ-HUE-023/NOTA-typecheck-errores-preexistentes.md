# Nota: errores de typecheck preexistentes, ajenos a REQ-HUE-023

`typecheck-api-full-20260908-185052.log` (exit 2) y `typecheck-root-full-20260908-185052.log`
(exit 2) traen errores preexistentes de trabajo no comiteado de OTROS requisitos que ya
estaban en el working tree al empezar esta tarea (`apps/api/src/pms/fraudScan.ts`,
`apps/api/src/routes/fraude.ts`, `apps/api/src/routes/pedidosFnb.ts`,
`tests/unit/domain-hotel/{fnb-allergy-guard,fraude-deteccion,parity-guard,
pronostico-series-tiempo,revenue-engine-gate,walk-forward-backtest}.spec.ts`, etc.) — todos
por exports de `@atiende-hoteles/domain-hotel` que esos módulos (fraude, F&B/alergias,
revenue-engine-gate, pronóstico) todavía no cablean en `packages/domain-hotel/src/index.ts`.
Mismo hallazgo ya documentado antes en `docs/logs/REQ-HUE-009/NOTA-typecheck-errores-preexistentes.md`
para este mismo working tree compartido (el repo tiene varios agentes trabajando en paralelo
sin comitear, ver instrucciones de esta tarea).

Verificado con `grep` sobre ambos logs por los archivos que ESTA tarea creó o modificó:
**0 coincidencias** para `conversationalGuardrails`, `guestContactChangeOtp`,
`guardrails-conversacionales`, `routes/agentes.ts`, `routes/tickets.ts`, `routes/huespedes.ts`,
`jobs/ticketEscalation.ts` — ninguno de esos archivos aparece en ninguno de los dos logs.
`typecheck-domain-hotel-20260908-185052.log` (el paquete puro donde vive la mitad
determinista de este requisito) typechequea **limpio (exit 0)**.

No se tocó ninguno de esos archivos ajenos: pertenecen a trabajo en curso de otros
requisitos (fraude/REQ-REC-014, REQ-REV-003/007, REQ-AB-004, etc.), fuera del alcance de
este encargo.
