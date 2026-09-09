# REQ-SEG-009 — evidencia (2026-09-09)

Criterio (`docs/REQUISITOS.md`): "Debe existir un procedimiento documentado y probado
de notificación de brechas de seguridad (detección, evaluación, notificación al
afectado y a la autoridad en plazo); una brecha de datos de pasaporte se considera
vulneración significativa que requiere notificación obligatoria." Estado previo:
`pendiente` (sin razón — nunca se había construido nada).

## Qué se encontró al llegar

`docs/runbooks/incidentes.md` §1 ya documentaba el procedimiento HUMANO (detección →
contención → evaluación → notificación → cierre), pero decía literalmente "registrar
la fecha de detección... idealmente como entrada en `audit_log` o, mientras no exista
un tipo de evento dedicado, en un documento fechado bajo `docs/logs/`" — es decir, NO
existía ningún mecanismo técnico real, solo la promesa de uno.

## Qué se construyó (mismo patrón ya aceptado para el camino del dinero, ADR-008)

- `apps/api/src/lib/securityBreachAlert.ts`: mismo contrato que `moneyAlert.ts`
  (`resolveSecurityBreachAlertDestination`/`hasSecurityBreachAlertDestination`/
  `dispatchSecurityBreachAlert`/`buildNoDestinationStartupLog`), namespace propio de
  variables de entorno (`SECURITY_BREACH_ALERT_*`), y `esVulneracionSignificativa()`
  con el criterio EXACTO del requisito ("pasaporte" → true), generalizado a INE/e.firma/
  CSD (documento de identidad y credenciales fiscales, mismas categorías que
  REQ-SEG-014/REQ-SEG-010).
- `apps/api/src/routes/incidentes.ts`: `POST/GET /hoteles/:hotelId/incidentes/brecha`
  (solo owner/gm) — declara la brecha vía `record_audit_log` (misma cadena de hash
  inmutable append-only de siempre, 0008/0012/0015/0016), calcula
  `vulneracionSignificativa`, y dispara la notificación (webhook genérico) SIN esperar a
  que alguien filtre logs.
- `apps/api/src/routes/health.ts`: `GET /ready` ahora también refleja
  `securityBreachAlertsConfigured` (mismo criterio que `moneyAlertsConfigured`).
- `apps/api/src/app.ts`: al arrancar, si ningún destino está configurado, lo declara con
  `nivel:"alerta"` (mismo patrón que el camino del dinero).
- `docs/runbooks/incidentes.md`: nueva §1.6 "Mecanismo técnico" con el `curl` real de
  declarar/listar una brecha y las variables de entorno.

## Por qué SÍ es "hecho" (mismo criterio que REQ-SEG-007/011/013)

El requisito pide un procedimiento "documentado y probado" — ambas mitades están
cerradas y verificadas contra Postgres real. Lo único pendiente es el DESTINO real de
producción (URL/credencial de Slack/PagerDuty/correo), que es una decisión operativa
sin código pendiente (mismo argumento ya aceptado para `MONEY_ALERT_*`) — nunca el
canal final de notificación al huésped/INAI, que sigue siendo el proceso humano del
runbook §1.4.1 (plazo/plantilla de asesoría legal, explícitamente no inventados).

## Evidencia (comandos reales, salida en esta carpeta)

- `vitest-incidentes-*.log` — `tests/integration/api/incidentes.spec.ts` (5/5, incluida
  una prueba que levanta un servidor HTTP REAL con `node:http` y confirma que recibe el
  POST del webhook con el JSON exacto de la alerta) + `tests/unit/api/security-breach-alert.spec.ts`
  (15/15).
- `typecheck-*.log` — `npm run typecheck` sin errores.
- Bloque nuevo de arranque/`/ready` en `tests/integration/api/observabilidad.spec.ts`
  (21/21 en ese archivo, incluidas las 2 pruebas nuevas) — corrida completa reportada en
  el resultado final de la tarea, no repetida aquí.
