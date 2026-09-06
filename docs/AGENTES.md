# Registro de agentes (modelo efectivo)

Regla: Fable (claude-fable-5-1) solo orquesta. Todo despacho usa `Agent(model="sonnet")` explícito; se verifica en el transcript JSONL del subagente (campo `model`) y se anota aquí.

| # | Fecha/hora | Nombre/tarea | Modelo solicitado | Modelo efectivo (evidencia) | Resultado |
|---|---|---|---|---|---|
| 1 | 2026-09-05 18:17 | ref-01 blueprint+DECISIONLLMHOTELES → docs/referencia/01 | sonnet | claude-sonnet-5 (grep "model" transcript: 15/15, 0 fable) | COMPLETADO: 173 BP + 31 LLM (204), 101 págs leídas completas |
| 2 | 2026-09-05 18:17 | ref-02 investigación H01–H11 → docs/referencia/02 | sonnet | claude-sonnet-5 (15/15) | COMPLETADO: 288 requisitos, 263 págs (11 PDF completos); usó 4 sub-agentes, todos claude-sonnet-5 verificados |
| 3 | 2026-09-05 18:17 | ref-03 investigación H12–H21 → docs/referencia/03 | sonnet | claude-sonnet-5 (20/20) | COMPLETADO: 262 págs + JSON ROI; ~90 req + catálogo 25 integraciones; H20 fija stack (Supabase RLS org→location, Sonnet/Haiku/Opus, LiveKit, WhatsApp Cloud, MCP, Inngest, Langfuse, PowerSync, pnpm+Turbo, edge por hotel) |
| 4 | 2026-09-05 18:17 | ref-04 gobierno y protocolo → docs/referencia/04 | sonnet | claude-sonnet-5 (26/26) | COMPLETADO: 59 GOB, 8 docs, 24 págs |
| 5 | 2026-09-05 18:17 | ref-05 inventario frontend Restaurantes → docs/referencia/05 | sonnet | claude-sonnet-5 (21/21) | COMPLETADO: 43 primitivos, 8 secciones admin, tokens light/dark, sin mobile real en AdminDashboard |
| 6 | 2026-09-05 18:17 | ref-06 back office/agentes/bucle Likida → docs/referencia/06 | sonnet | claude-sonnet-5 (7/7) | COMPLETADO: copia 3f98a96 (24-ago) confirmada más reciente; 5 patrones a portar; bucle launchd+claude -p documentado |
| 7 | 2026-09-05 18:17 | ref-07 viabilidad stack sin Docker → docs/referencia/07 | sonnet | claude-sonnet-5 (6/6) | COMPLETADO: PGlite 5/5 tests RLS (serializa); embedded-postgres 18.4 real con concurrencia; supabase CLI exige Docker para diff/gen/start; Playwright+Chrome sistema OK |

Orquestador de esta sesión: claude-fable-5-1 (verificado por el entorno). Ningún subagente Fable creado.

**Verificación de herencia (2026-09-05):** grep del campo `model` en los 12 transcripts de agentes de la sesión (7 principales + sub-agentes anidados que lanzó el #2 y el #3): todos `claude-sonnet-5`; `grep -l claude-fable` → ninguno.
| 8 | 2026-09-05 18:52 | consolidar docs/REQUISITOS.md (matriz canónica) | sonnet | verificación en curso (grep model al arrancar) | en curso |
| 9 | 2026-09-05 18:52 | decidir docs/ARQUITECTURA.md (ADR-001..010) | sonnet | verificación en curso → claude-sonnet-5 (6/6) | COMPLETADO: ADR-001..010, 323 líneas, 8 desvíos vs H20 justificados |
| 10 | 2026-09-05 18:58 | docs/auditoria/RUBROS.md + AUDITOR-PROMPT.md (protocolo hotelero) | sonnet | ver grep al arrancar | en curso |
| 11 | 2026-09-05 18:58 | evidencia ampliada B-001 (wiki/memoria/historial) | sonnet | ver grep al arrancar | en curso |
