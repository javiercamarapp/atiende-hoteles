# Progreso (se escribe mientras se avanza)

Formato: requisito · acción · archivos/commit · prueba · resultado · siguiente paso.

## 2026-09-05
- R-0 (continuidad) · CronCreate `f24bfd35` (cada 2h :37, sesión) + /loop dinámico (ScheduleWakeup) · docs/operacion-bucle.md · CronList · pendiente evidencia 1ª ejecución · siguiente: despachar Sonnet.
- R-0 (ubicación) · barrido local de "empresas agénticas" · docs/BLOQUEOS.md B-001 · — · NO ENCONTRADA · siguiente: esperar ruta del usuario; trabajo de requisitos sigue.
- R-GOB · extracción 05-Gobierno-y-protocolo (Sonnet #4) · docs/referencia/04-gobierno-y-protocolo.md · lectura completa 24/24 págs · 59 requisitos GOB · siguiente: consolidar en docs/REQUISITOS.md cuando terminen #1-#3.
- R-FRONT-REF · inventario frontend Restaurantes (Sonnet #5) · docs/referencia/05-frontend-restaurantes.md · lectura solo-lectura, sin secretos · stack Vite 8.2.2/React 18.3.1/TS 5.8.3/Tailwind 3.4.17/shadcn; logo SVG inline; AdminDashboard sin mobile real · siguiente: usar como base del scaffold hotelero cuando llegue 07-stack.
- R-BACKOFFICE-REF · patrón Likida (Sonnet #6) · docs/referencia/06-backoffice-agentes-likida.md · solo lectura, copia más reciente verificada 3f98a96 · portables: tools sin datos del modelo, mutex fail-closed, presupuesto, loop-guard+fallback, nunca inventar cifra · siguiente: arquitectura hotelera con 07-stack.
- R-BP/LLM · blueprint + DECISIONLLMHOTELES (Sonnet #1) · docs/referencia/01-blueprint-y-decision-llm.md · 101/101 págs · 204 requisitos; runtime por rol (Sonnet canal, Haiku enrutador, Opus batch nocturno), LLM nunca decide precio/ISH/IVA, aprobación humana en dinero · siguiente: consolidar REQUISITOS.md al terminar #2 y #3.
- R-STACK · viabilidad sin Docker (Sonnet #7) · docs/referencia/07-stack-viabilidad.md · experimentos reales (vitest 5 passed en PGlite; embedded-postgres 18.4 arrancó y demostró concurrencia; Playwright channel chrome pasó E2E) · recomendación: Vite+React+shadcn / Hono+JWT / PGlite tests + embedded-postgres integración / Supabase real = integración pendiente · siguiente: ARQUITECTURA.md cuando llegue H20 (#3).
