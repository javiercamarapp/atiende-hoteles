# Operación del bucle (continuidad real)

Versión de Claude Code verificada: **2.1.261**. Mecanismos disponibles inspeccionados (no inventados): `/loop` (skill; sin intervalo = modo dinámico autoprogramado vía `ScheduleWakeup`), `CronCreate/CronList/CronDelete` (sesión), `Monitor`. La sintaxis antigua de Likida (`/loop 0 6 * * * /auditoria-diaria`) NO se reutilizó a ciegas: se invocó `/loop` real en esta versión y se siguieron sus instrucciones.

## Mecanismo primario — `/loop` dinámico (ScheduleWakeup)
- **Identificador:** no emite ID; su evidencia es la llamada `ScheduleWakeup` al cierre de cada turno y el siguiente despertar registrado en `docs/logs/bucle.log`.
- **Frecuencia:** autoprogramada, 60–3600 s (clamp de la herramienta). Fable elige 1200–1800 s de latido cuando hay agentes Sonnet corriendo (las notificaciones de agentes despiertan antes) y más corto si hay trabajo inmediato.
- **Persistencia:** solo sesión. Muere si la sesión de Claude Code se cierra.

## Mecanismo de respaldo — CronCreate
- **ID:** `f24bfd35`
- **Cron:** `37 */2 * * *` (cada 2 h al minuto 37, hora local). Recurrente. Solo dispara con la sesión ociosa.
- **Persistencia:** solo sesión (no se escribe en disco). **Autoexpira a los 7 días** (dispara una última vez y se borra).
- **Prompt:** reanuda el ciclo Likida si el bucle dinámico murió; si sigue vivo, solo registra latido.

## Alcance del ciclo (patrón Likida adaptado)
implementación (Sonnet) → pruebas (Sonnet, salida real guardada en `docs/logs/`) → auditoría adversarial (Sonnet, contexto independiente, un archivo por rubro en `docs/auditoria-N/`) → corrección (Sonnet, un hallazgo = un commit) → reverificación (Sonnet). Fable (claude-fable-5-1) solo despacha, verifica y decide; nunca construye.

## Condición de parada
1. Todos los criterios de `docs/ACEPTACION.md` satisfechos con evidencia (comando + salida) y sin defectos críticos/altos abiertos; o
2. Bloqueo externo real sin trabajo independiente restante: 3 intentos sin progreso documentados en `docs/BLOQUEOS.md`.
Al parar: `ScheduleWakeup(stop:true)`, `CronDelete f24bfd35`, `PushNotification` al usuario, entrada final en `docs/PROGRESO.md`.

## Reanudación tras cierre de sesión
```
cd /Users/javiercamaraportepetit/Documents/Codex/atiende-hoteles-staging   # o la ruta definitiva
claude --model fable
# dentro de la sesión:
/loop
# y pegar: "Lee docs/operacion-bucle.md, docs/PROGRESO.md y docs/BLOQUEOS.md y reanuda el ciclo Likida de Atiende Hoteles; solo agentes model=sonnet."
```
Reanudar desde archivos: `docs/PROGRESO.md` (último paso), `docs/BLOQUEOS.md`, `docs/auditoria-N/`, `git log`. No repetir trabajo validado.

## Evidencia de ejecución
- 2026-09-05 — `CronCreate` → `Scheduled recurring job f24bfd35 (Every 2 hours at :37). Session-only... Auto-expires after 7 days.`
- 2026-09-05 — `CronList` → `f24bfd35 — Every 2 hours at :37 (recurring) [session-only]`.
- Latidos y despertares: ver `docs/logs/bucle.log` (se anexa uno por ciclo).
- 2026-09-05 19:07 — **Primera ejecución real del cron `f24bfd35`** (prompt de latido recibido en la sesión). El bucle dinámico estaba vivo y el agente Sonnet #8 en curso → solo se registró el latido, sin duplicar trabajo.
- 2026-09-05 20:29 — **Parada del bucle** por condición 2 (bloqueo externo B-001 sin trabajo independiente restante). Ciclos ejecutados: 6 dinámicos + 1 disparo real de cron. Agentes Sonnet despachados: 16 (todos verificados claude-sonnet-5). `CronDelete f24bfd35` ejecutado; `ScheduleWakeup(stop)` emitido; PushNotification enviada.
- 2026-09-06 04:24 — **Reanudación** por instrucción del usuario ("continua"). Nuevo cron de respaldo **`4fe17d3a`** (`41 */2 * * *`, sesión, 7 días). /loop dinámico rearmado. Fase: construcción, hito H1 (y H3 en paralelo en worktree).
