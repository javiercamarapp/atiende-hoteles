# Registro de agentes (modelo efectivo)

Regla: Fable (claude-fable-5-1) solo orquesta. Todo despacho usa `Agent(model="sonnet")` explícito; se verifica en el transcript JSONL del subagente (campo `model`) y se anota aquí.

| # | Fecha/hora | Nombre/tarea | Modelo solicitado | Modelo efectivo (evidencia) | Resultado |
|---|---|---|---|---|---|
| 1 | 2026-09-05 18:17 | ref-01 blueprint+DECISIONLLMHOTELES → docs/referencia/01 | sonnet | claude-sonnet-5 (grep "model" transcript: 15/15, 0 fable) | en curso |
| 2 | 2026-09-05 18:17 | ref-02 investigación H01–H11 → docs/referencia/02 | sonnet | claude-sonnet-5 (15/15) | en curso |
| 3 | 2026-09-05 18:17 | ref-03 investigación H12–H21 → docs/referencia/03 | sonnet | claude-sonnet-5 (20/20) | en curso |
| 4 | 2026-09-05 18:17 | ref-04 gobierno y protocolo → docs/referencia/04 | sonnet | claude-sonnet-5 (26/26) | COMPLETADO: 59 GOB, 8 docs, 24 págs |
| 5 | 2026-09-05 18:17 | ref-05 inventario frontend Restaurantes → docs/referencia/05 | sonnet | claude-sonnet-5 (21/21) | COMPLETADO: 43 primitivos, 8 secciones admin, tokens light/dark, sin mobile real en AdminDashboard |
| 6 | 2026-09-05 18:17 | ref-06 back office/agentes/bucle Likida → docs/referencia/06 | sonnet | claude-sonnet-5 (7/7) | en curso |
| 7 | 2026-09-05 18:17 | ref-07 viabilidad stack sin Docker → docs/referencia/07 | sonnet | claude-sonnet-5 (6/6) | en curso |

Orquestador de esta sesión: claude-fable-5-1 (verificado por el entorno). Ningún subagente Fable creado.
