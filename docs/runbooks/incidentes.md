# Runbook — Incidentes

Cubre los tres escenarios que ADR-008 exige explícitamente: (1) brecha de seguridad
(H19-010/REQ-SEG-009), (2) caída de un conector externo (outbox), (3) error del
camino del dinero. Cada uno documenta detección → contención → notificación →
cierre, con los comandos/consultas reales de este repo (no genéricos).

---

## 1. Brecha de seguridad (H19-010, REQ-SEG-009)

**Qué cuenta como brecha significativa** (REQ-SEG-009): cualquier acceso, divulgación
o pérdida no autorizada de datos personales de huéspedes/personal — en particular,
copias de identificación (pasaporte/INE), datos de pago, o credenciales fiscales
(e.firma/CSD, REQ-SEG-010). Un secreto de aplicación expuesto (JWT_SECRET, credencial
de BD) que permita ACCEDER a esos datos también cuenta, aunque el dato en sí no se
haya visto todavía.

### 1.1 Detección
- Alerta de `nivel: "alerta"` en logs con volumen anómalo desde un mismo `user_id`/IP.
- Reporte externo (proveedor, usuario, escaneo de seguridad).
- `git log`/GitHub secret scanning detecta un secreto commiteado (REQ-SEG-012 exige
  escaneo de secretos en cada PR — ver `docs/runbooks/despliegue.md` §CI).
- Auditoría periódica (`docs/auditoria-N/`, ADR-010) marca un hallazgo CRÍTICO de
  seguridad.

### 1.2 Contención inmediata (primeras 1-2 horas)
1. **Revocar el vector**: si es un secreto expuesto → rotarlo YA (runbook de
   operación §6), sin esperar el análisis completo. Si es una sesión/token robado →
   no hay lista de revocación de tokens individuales hoy (JWT sin `jti` en blacklist,
   deuda documentada); la contención real es rotar `JWT_SECRET` (invalida TODAS las
   sesiones, incluida la comprometida) o, si el impacto es menor, esperar a que expire
   el access token (máx. 15 min, `ACCESS_TOKEN_TTL_SECONDS`).
2. **Aislar el alcance**: usar `record_audit_log`/`audit_log` (inmutable,
   `packages/db/migrations/0008_audit_log.sql`) para reconstruir exactamente qué filas
   tocó el actor comprometido — cada entrada tiene `actor_id`, `hotel_id`, `tenant_id`,
   `action`, `entity_type`, `entity_id`, y la cadena de hash permite confirmar que no
   se alteró el registro después del hecho (`tests/unit/audit-log.spec.ts`).
   ```sql
   select * from public.audit_log
   where actor_id = '<uuid-del-actor-sospechoso>'
     and created_at between '<inicio-de-ventana>' and '<fin-de-ventana>'
   order by created_at;
   ```
3. **Preservar evidencia**: exportar el resultado de esa consulta y los logs
   estructurados relevantes ANTES de cualquier rotación/reinicio que pudiera perder
   contexto en memoria.

### 1.3 Evaluación de impacto
- ¿Qué campos se expusieron? Cruzar contra `REDACT_PATHS`
  (`apps/api/src/logger.ts`) — si el vector fue un log, esos campos NUNCA debieron
  aparecer en texto plano; si aparecieron, es en sí mismo un hallazgo de la brecha
  (revisar por qué la redacción no cubrió ese campo y añadirlo).
- ¿Hay datos de identidad (pasaporte, RFC, CURP) involucrados? → notificación
  obligatoria (REQ-SEG-009: "una brecha de datos de pasaporte se considera
  vulneración significativa").
- ¿Hay datos de pago? El PAN completo nunca debe estar en este sistema
  (REQ-SEG-005, tokenización obligatoria del PSP) — si apareciera, es un hallazgo
  CRÍTICO aparte de la brecha misma.

### 1.4 Notificación (plazo legal, LFPDPPP)
1. Notificar al afectado y a la autoridad (INAI) dentro del plazo legal aplicable —
   **pendiente de definir el plazo exacto y la plantilla de notificación con
   asesoría legal**; no se inventa un plazo aquí. Registrar la fecha de detección
   (dispara el conteo del plazo) de forma inmutable — desde REQ-SEG-009 (2026-09-08)
   esto YA NO es "idealmente" ni un documento suelto: **declarar la brecha vía
   `POST /hoteles/:hotelId/incidentes/brecha`** (§1.6 abajo) deja esa marca de tiempo
   como una fila real e inmutable de `audit_log` (misma cadena de hash append-only que
   el resto del repo, 0008/0012/0015/0016) — nunca la reconstruyas a mano en un `.md`
   cuando el mecanismo real ya existe.
2. Informar internamente (fundador/responsable de datos) sin demora, incluso antes de
   tener el análisis completo — el mismo endpoint de §1.6 ya dispara esto (webhook
   configurable), no dependas solo de avisar por Slack/WhatsApp a mano.

### 1.5 Cierre
- Postmortem escrito (qué pasó, cómo se detectó, qué se rotó/aisló, qué cambia para
  que no se repita) — guardar en `docs/logs/incidente-<fecha>-<slug>.md`.
- Confirmar con `GET /hoteles/:hotelId/incidentes/brecha` (§1.6) que el incidente quedó
  listado y con el `categoria`/`vulneracionSignificativa` correctos antes de cerrar.

### 1.6 Mecanismo técnico (REQ-SEG-009 — documentado Y probado)

Lo de arriba (1.1–1.5) es el procedimiento HUMANO. Esto es el código real que lo
sostiene — `apps/api/src/routes/incidentes.ts` + `apps/api/src/lib/securityBreachAlert.ts`,
probado de punta a punta contra un servidor HTTP real (no solo mocks) en
`tests/integration/api/incidentes.spec.ts` y a nivel de unidad en
`tests/unit/api/security-breach-alert.spec.ts`.

**Declarar una brecha** (owner/gm únicamente — mismo nivel que aprobar una presentación
SAT, REQ-SEG-010):
```
curl -X POST https://<api>/hoteles/<hotelId>/incidentes/brecha \
  -H "authorization: Bearer <token-owner-o-gm>" \
  -H "content-type: application/json" \
  -d '{
    "categoria": "documento_identidad",
    "descripcion": "Descripción real de lo que pasó, qué se detectó y cuándo.",
    "datosInvolucrados": ["pasaporte"]
  }'
```
Categorías válidas: `documento_identidad`, `datos_pago`, `credencial_fiscal`,
`credencial_aplicacion`, `conversacion_huesped`, `otro`. `datosInvolucrados` es una
lista libre corta (ej. `["pasaporte"]`, `["efirma"]`) — si incluye
`pasaporte`/`ine`/`documento_identidad`/`efirma`/`csd`/`credencial_fiscal`, la
respuesta trae `vulneracionSignificativa: true` (criterio EXACTO de REQ-SEG-009: "una
brecha de datos de pasaporte se considera vulneración significativa").

La respuesta (`201`) trae `incidenteId` + `detectadoEn` (la marca de tiempo inmutable
que dispara el conteo del plazo legal, §1.4) — guárdalos en el postmortem.

**Listar brechas declaradas de un hotel** (para el postmortem/auditoría, §1.5):
```
curl https://<api>/hoteles/<hotelId>/incidentes/brecha -H "authorization: Bearer <token-owner-o-gm>"
```

**Notificación interna activa (sin demora, §1.4.2)**: configurable por variable de
entorno, mismo patrón ya aceptado para el camino del dinero (ADR-008,
`MONEY_ALERT_*`/`apps/api/src/lib/moneyAlert.ts`) — un webhook GENÉRICO, sin acoplarse
a ningún proveedor concreto:
- `SECURITY_BREACH_ALERT_WEBHOOK_URL`: si se define, cada brecha declarada se envía por
  HTTP POST (JSON) a esa URL — un Slack Incoming Webhook, PagerDuty Events API, un
  endpoint propio, o un relevo tipo Zapier/Make.
- `SECURITY_BREACH_ALERT_EMAIL_TO` + `SECURITY_BREACH_ALERT_EMAIL_WEBHOOK_URL`: si
  AMBAS se definen, se envía además `{ to, subject, alert }` a ese webhook de correo.

**Sin ninguna de las dos configuradas**: la brecha SIGUE quedando registrada de forma
inmutable (nunca depende de la notificación para persistir), pero `createApp()` lo
declara al arrancar el proceso con `nivel: "alerta"` / `tipo:
"alerta_brecha_seguridad_sin_destinatario"`, y `GET /ready` lo refleja en
`securityBreachAlertsConfigured: false` — confirma ese campo antes de asumir que
"alguien ya se habría enterado" de una brecha anterior (mismo criterio que §3 de este
runbook para las alertas del camino del dinero).

**LÍMITE EXPLICITO (pendiente de credenciales, no de código)**: el destino REAL de
producción (a qué Slack/PagerDuty/correo llega la alerta) no está configurado en este
entorno (ADR-007) — configurar esas variables con la URL/credencial real es una
decisión operativa del fundador, no requiere ningún cambio de código. El canal FINAL
de notificación al huésped afectado y a la autoridad (INAI) sigue siendo el proceso
humano de §1.4.1 (plazo/plantilla pendientes de asesoría legal) — este mecanismo nunca
notifica directamente a un huésped ni a una autoridad.
- Si el vector fue un bug de código (ej. CORS/rate limit/redacción insuficiente),
  abrir la corrección con su propia prueba adversarial ANTES de cerrar el incidente.

---

## 2. Caída de un conector externo (outbox se satura)

Aplica a cualquier integración que consuma el outbox (WhatsApp, PMS, pasarela, CFDI —
ADR-007, hoy sin credenciales reales) una vez existan handlers registrados.

### 2.1 Detección
- `outbox_dead_letter` en `/metrics` sube por encima de 0 y no baja.
- `outbox_pending` crece sostenido (el conector no está drenando al ritmo que se
  encolan eventos).

### 2.2 Diagnóstico
```sql
select event_type, status, count(*), max(attempts) as max_intentos
from public.outbox
group by event_type, status
order by count(*) desc;

-- Ver la causa real del último fallo de un evento específico (0020_outbox_last_error):
select id, event_type, attempts, last_error, available_at
from public.outbox
where status in ('pendiente', 'fallido')
order by attempts desc
limit 20;
```
`last_error` trae el mensaje real (incluyendo `handler_timeout: ...` si el conector
externo dejó de responder) — nunca un `catch {}` mudo (auditoria-1/backend [ALTO],
corregido en `apps/api/src/outbox/worker.ts`).

### 2.3 Contención
- El outbox **ya drena solo** (reintentos con backoff exponencial, `computeBackoffMs`,
  techo `maxDelayMs`) — no hace falta intervención para fallos transitorios cortos.
- Si el conector externo está caído por más tiempo del que el backoff cubre, los
  eventos alcanzan `maxAttempts` y quedan `fallido` (dead-letter) — **nunca se
  pierden**, quedan en la tabla para reintento manual:
  ```sql
  update public.outbox
  set status = 'pendiente', attempts = 0, available_at = now(), last_error = null
  where id = '<uuid-del-evento>';
  ```
  Reintentar EN LOTE solo después de confirmar que el conector externo volvió (un
  reintento masivo contra un proveedor todavía caído solo genera más dead-letter).

### 2.4 Notificación
- Si el conector caído es de dinero (pagos/CFDI): tratar como camino del dinero
  (§3 de este runbook) además de esto.
- Si es de mensajería (WhatsApp): degradar honestamente hacia el huésped/staff (REQ-UX-002,
  "nunca fingir un envío exitoso") en vez de reintentar silenciosamente sin límite.

### 2.5 Cierre
- Confirmar `outbox_dead_letter` de vuelta a 0 (todo reencolado y entregado, o
  descartado explícitamente con justificación documentada — nunca se borra sin dejar
  rastro en `audit_log`).

---

## 3. Error del camino del dinero (`nivel: "alerta"`)

### 3.1 Detección
Buscar en logs: `nivel = "alerta"` y `tipo = "error_camino_dinero"`
(`apps/api/src/lib/moneyAlert.ts`). Cada línea trae `route`, `status`, `org_id`,
`hotel_id`, `user_id`, `request_id`, `error`.

**auditoria-2/operabilidad [ALTO], corregido**: si el proceso tiene
`MONEY_ALERT_WEBHOOK_URL` (webhook genérico: Slack/PagerDuty/endpoint propio/relevo a
correo) y/o el par `MONEY_ALERT_EMAIL_TO`+`MONEY_ALERT_EMAIL_WEBHOOK_URL` configurados
(ver `apps/api/README.md` "Observabilidad"), la misma alerta también se entrega ahí por
HTTP POST — no depende únicamente de que alguien esté mirando/filtrando los logs
activamente. **Si ninguno está configurado**, el arranque del proceso ya lo declara con
otra línea `nivel: "alerta"` (`tipo: "alerta_camino_dinero_sin_destinatario"`) y
`GET /ready` lo refleja en `moneyAlertsConfigured: false` — confirmar ese campo antes
de asumir que "alguien ya se habría enterado" de una alerta anterior.

### 3.2 Diagnóstico
1. **auditoria-2/operabilidad [MEDIO], corregido**: la alerta ya trae
   `reservation_id`/`folio_id`/`charge_id`/`payment_id` cuando el path de la request los
   incluye (`apps/api/src/lib/moneyAlert.ts::extractMoneyIdsFromPath`) -- ya NO hace
   falta ir a buscar la línea `request` aparte solo para saber a qué folio/reserva
   corresponde el error. Esa línea sigue siendo útil para el `path`/`method`/
   `duration_ms` completos si se necesita más contexto: con el `request_id` de la
   alerta, buscar la línea `request` correspondiente (mismo `request_id`).
2. Con `org_id`/`hotel_id`, revisar `audit_log` de esa ventana para ver si la
   operación (cargo/pago/reserva) quedó a medias:
   ```sql
   select * from public.audit_log
   where hotel_id = '<hotel_id-de-la-alerta>'
   order by created_at desc
   limit 20;
   ```
3. Confirmar si la transacción de BD revirtió completa (comportamiento esperado: un
   fallo del outbox en la misma transacción revierte también el cambio de dominio,
   `tests/integration/outbox-atomicity.spec.ts`) o si quedó un estado inconsistente
   real (esto sí sería un bug nuevo a reportar, no un caso ya cubierto).

### 3.3 Contención
- Si es un huésped con un cargo/pago duplicado sospechado: verificar
  `idempotency_key` de esa operación — la unicidad es por `(tenant_id, scope, key)`
  con TTL (`packages/db/migrations/0022_idempotency_key_ttl.sql`); un duplicado real
  con la MISMA clave es imposible por constraint, así que un cargo duplicado real
  implica dos claves distintas (posible doble-clic sin idempotencia del lado del
  cliente) — no un fallo del servidor.
- Si el error es reproducible (mismo `route`+payload siempre falla): considerar
  desactivar temporalmente esa ruta específica (feature flag o revertir el último
  deploy, ver `docs/runbooks/despliegue.md` §rollback) antes de que más huéspedes lo
  disparen.

### 3.4 Cierre
- Prueba de regresión añadida ANTES de cerrar (mismo principio que la auditoría-1:
  "un ataque/bug que rompe = bug encontrado con su prueba ya lista").
