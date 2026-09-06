# Backend y API — auditoría 2

**Nota: 4/10** (antes 5/10). Razón del movimiento: deuda que cobró factura. Los ocho
hallazgos abiertos de la auditoría 1 están **CERRADOS** de verdad (verificado con
tests corridos hoy, no solo leyendo el commit) — trabajo real y bien hecho. Pero el
código **nuevo** desde entonces (night audit propio H5, aprobaciones de dinero H6b)
introduce exactamente el patrón que la propia auditoría 1 identificó como el techo de
nota más bajo posible: *"4 o menos si existe un camino donde ... un cargo se puede
postear dos veces"*. Reproduje ese camino dos veces, por dos rutas de entrada
independientes, contra `embedded-postgres` real. La ronda 1 cerró bien su tarea; la
ronda 2 encuentra que el código construido después no heredó la disciplina de lock
que sí tienen `book_availability()`/`night_audit_claim()`/`idempotency_key`.

El riesgo mayor hoy: la penalización de no-show de una reserva vencida se puede
postear **dos veces** al folio del huésped con solo disparar el endpoint operativo
`POST /hoteles/:hotelId/reservas/procesar-no-show` dos veces casi al mismo tiempo (dos
clics, un reintento de red) — no hace falta ni siquiera un crash a mitad de camino, y
no existe ningún índice único ni lock que lo impida. Lo reproduje de forma
determinista contra `embedded-postgres` real.

## Método

Repo/código auditado: `.claude/worktrees/auditoria-2-snapshot` (solo lectura, ningún
archivo del snapshot quedó modificado — verificado con `git status --porcelain` antes
y después). Usé cinco líneas de investigación en paralelo (folio/night
audit/CFDI; housekeeping/mantenimiento/aprobaciones/mensajería; agentes/ROI/agent-core;
rutas públicas/bóveda/rate-limit; y verificación uno-por-uno de los 8 hallazgos
abiertos de `docs/auditoria-1/backend.md` contra el código actual), y luego verifiqué
personalmente con lectura directa de archivo:línea y, para los dos hallazgos CRÍTICOS,
con una prueba de reproducción escrita en `tests/integration/.../_tmp_audit2_*.spec.ts`
dentro del snapshot, ejecutada con `npx vitest run ... --pool=forks
--poolOptions.forks.singleFork` contra `embedded-postgres` real, y **borrada
inmediatamente después** de confirmar el resultado (no queda ningún archivo nuevo en
el snapshot; `git status --porcelain` vuelve a estar limpio salvo capturas de pantalla
`.png` preexistentes no relacionadas con este trabajo).

## Hallazgos abiertos de la ronda anterior — verificación uno por uno

Los ocho hallazgos de `docs/auditoria-1/backend.md` (2 CRÍTICO, 3 ALTO, 1 MEDIO, 2
BAJO) están **CERRADOS**, confirmado contra el código de hoy, no solo contra el texto
de `docs/auditoria-1/correccion-bd.md`:

1. **Cancelar/no_show nunca liberaba inventario** → cerrado: `release_availability()`
   (`packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:160-193`) invocado
   en `apps/api/src/routes/reservas.ts` (cancelación, cambio de fechas) y en
   `apps/api/src/jobs/noShow.ts:73-77`.
2. **Noche sin tarifa cobraba $0 sin error** → cerrado: `quoteNetAmount`
   (`apps/api/src/routes/reservas.ts:44-73`) lanza `QuoteError sin_tarifa` → 409,
   verificado antes de tocar `book_availability()`.
3. **Cadena de hash de `audit_log` se bifurcaba bajo concurrencia** → cerrado desde H4
   (`audit_log_chain_head` + `SELECT ... FOR UPDATE`,
   `packages/db/migrations/0015_audit_log_advisory_lock.sql`); re-confirmado hoy
   corriendo `npx vitest run tests/integration/audit-log-concurrencia.spec.ts` → 4/4
   verde (20 escrituras concurrentes × 8 rondas, sin bifurcación).
4. **No existía camino en la API para crear un folio** → cerrado:
   `apps/api/src/routes/reservas.ts:334-362` crea el folio dentro de la transición a
   `confirmada`, con la sesión normal de la API (rol `authenticated`), no con el
   cliente admin.
5. **El worker de outbox descartaba la causa real del error y no aplicaba timeout** →
   cerrado: `apps/api/src/outbox/worker.ts` captura y persiste `last_error`
   (migración `0020`) y envuelve cada `handler(row)` en `withTimeout()`; re-confirmado
   corriendo `npx vitest run tests/unit/api/outbox-worker.spec.ts` → 8/8 verde. Sin
   regresión: seguí leyendo el archivo completo hoy y no hay ningún `catch {}` vacío.
6. **Cada request abría una conexión Postgres nueva, sin pool** → cerrado:
   `packages/db/src/engines.ts:209-247` usa un `pg.Pool` de proceso con
   `connectionTimeoutMillis`/`statement_timeout` configurables.
7. **`room_type_id` no scoped a `hotel_id` (FK simple)** → cerrado: FK compuesta
   `packages/db/migrations/0018_room_type_id_fk_compuesta_por_hotel.sql`.
8. **`charge.reversed_by` sin policy de UPDATE** → cerrado por la ruta alternativa que
   el propio hallazgo original contemplaba: función `SECURITY DEFINER`
   `mark_charge_reversed()` (`packages/db/migrations/0030_folio_engine.sql:33-59`),
   invocada desde `POST /hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso`;
   re-confirmado corriendo `npx vitest run
   tests/integration/folio/cargos-descuentos-reverso.spec.ts` → 7/7 verde, incluido un
   reverso real vía `fixture.app.request(...)` (no cliente admin).

Nada de la ronda 1 es REINCIDENTE.

## Hallazgos (código nuevo desde auditoría 1: H5 folio/night-audit/CFDI, H6b
aprobaciones/housekeeping/mensajería, H7 agentes/ROI, P0 rutas públicas)

### [CRÍTICO] `POST /reservas/procesar-no-show` sin `Idempotency-Key` postea la penalización de no-show dos veces con solo dos clics
`apps/api/src/routes/reservas.ts:542-555` (el endpoint no exige `Idempotency-Key` ni
llama a `withIdempotency`, a diferencia de **todos** los demás endpoints de dinero de
`folios.ts`/`cfdi.ts`); `apps/api/src/jobs/noShow.ts:40-118`, en particular la
ausencia de guarda en el `UPDATE` de la línea 82-87 (`update ... set status='no_show'
... where id=$2`, sin `and status='confirmada'`) y la ausencia de cualquier
restricción única en el `INSERT` de la línea 100-105 (`insert into charge (...
'Penalización por no-show' ...)`) — a diferencia del cargo de hospedaje del night
audit, que sí tiene el índice único parcial `charge_folio_stay_date_hospedaje_idx`
(migración 0030).

Escenario reproducido: una reserva con `check_in_date=2026-09-07`,
`check_out_date=2026-09-08`, `status='confirmada'`, monto 1500 MXN
(`no_show_pct=100`, política por defecto). Disparé `Promise.all([POST
/hoteles/:hotelId/reservas/procesar-no-show, POST .../procesar-no-show])` con
`asOfDate=2026-09-12` — dos requests HTTP concurrentes, dos transacciones de Postgres
independientes bajo READ COMMITTED (cada una es su propia transacción de sesión,
`dbSession`). Ambas leen la reserva con `status='confirmada'` antes de que cualquiera
haga el `UPDATE`, ambas la procesan: **ambas devuelven 200**, y quedan **2 filas** en
`charge` con `description='Penalización por no-show'` para el mismo folio (verificado
con `select count(*) from charge where folio_id=$1 and description='Penalización por
no-show'` → `2`, prueba corrida contra `embedded-postgres` real, borrada tras
confirmar el resultado).

Consecuencia: el huésped ve el doble de penalización de no-show cargada a su folio —
dinero mal, exactamente el escenario que el ancla de 4/10 de `docs/auditoria/RUBROS.md`
describe. Esto es alcanzable por cualquier owner/gm con un doble clic normal en el
panel de back-office, sin necesitar ningún ataque ni condición de infraestructura
especial.

Causa raíz probable: `runNoShowJob()` trata el filtro `status='confirmada'` como
suficiente para la idempotencia (correcto solo para corridas *secuenciales* después de
que la primera ya hizo commit) y el endpoint que lo expone no exige `Idempotency-Key`
como sí lo exigen `folios.ts`/`cfdi.ts`.

Prueba que lo cubre hoy: `tests/integration/reservas/no-show-idempotente.spec.ts`
solo corre el job dos veces **secuencialmente** (nunca `Promise.all`); no existe
ningún test de concurrencia real para este endpoint.

### [CRÍTICO] El advisory lock de night audit no protege el camino real de producción (el planificador automático), solo el disparo manual por HTTP — dos réplicas duplican el mismo cargo
`packages/db/migrations/0031_night_audit.sql:34-52` (`night_audit_claim()`, con
`pg_advisory_xact_lock` **transaccional** — se libera al terminar la transacción que
lo pidió); `apps/api/src/jobs/nightAudit.ts:37-134` (`runNightAudit`, nunca abre su
propio `BEGIN`, asume que `db` ya es una transacción del llamador);
`apps/api/src/server.ts:42` (`startNightAuditScheduler(engine.admin, {...})`);
`packages/db/src/engines.ts:76-86` (`engine.admin` es un `pg.Client` crudo, sin ningún
`BEGIN`/`COMMIT` envolvente — cada `db.query()` es su propia sentencia autocommiteada).

El endpoint manual (`POST /hoteles/:hotelId/night-audit`) sí es seguro porque corre
dentro de la transacción única por-request de `dbSession` (`packages/db/src/engines.ts:
229-247`): el `pg_advisory_xact_lock` queda tomado durante TODA la corrida, y una
segunda llamada concurrente se bloquea hasta que la primera termina y comitea —
exactamente lo que prueba `tests/integration/revenue/night-audit.spec.ts:114-135`. Pero
el planificador real (el que corre solo, sin intervención humana, que es el propósito
de REQ-REV-013) usa `engine.admin`: `night_audit_claim()` toma el lock, hace su
`INSERT`, y lo **libera de inmediato** al terminar esa única sentencia — mucho antes de
que el resto de `runNightAudit` (posteo de cargos, `runNoShowJob`, `night_audit_finish`)
se ejecute.

Escenario reproducido: construí dos instancias **independientes** de
`NightAuditScheduler` (simulando dos réplicas de `apps/api` en producción, tal como el
propio comentario de `nightAuditScheduler.ts:9-13` dice que debe soportar: *"correcto
incluso con VARIOS procesos/instancias de apps/api corriendo el planificador a la vez"*),
ambas apuntando al mismo `fixture.engine.admin`, y llamé
`Promise.all([schedulerA.tick(hoteles), schedulerB.tick(hoteles)])` para un hotel con
una reserva no-show pendiente. Resultado: **`night_audit_run` queda con exactamente 1
fila** (la capa de idempotencia del *run* sí funciona), pero la penalización de
no-show se postea **2 veces** (`select count(*) from charge where description=
'Penalización por no-show'` → `2`) — la misma familia de bug que el hallazgo anterior,
alcanzada sin tocar ningún endpoint HTTP, solo por el mecanismo automático que
`REQ-REV-013`/P0 construyó para que nadie tenga que dispararlo a mano.

Consecuencia: en cuanto `apps/api` corra con más de una réplica (topología normal para
cumplir REQ-OBS-002, 99.9% de disponibilidad), el planificador de night audit de CADA
réplica hace `tick()` cada 15 minutos de forma independiente y sincronizada por reloj
de pared — dos réplicas cerrando el mismo hotel casi al mismo tiempo (algo probable, no
un caso de laboratorio) duplican la penalización de no-show real cobrada al huésped.

Causa raíz probable: `pg_advisory_xact_lock` es transaccional por diseño, pero
`runNightAudit()` se invoca fuera de una transacción explícita cuando el llamador es
`engine.admin` — el comentario de cabecera de `nightAuditScheduler.ts` documenta una
garantía cross-proceso que la implementación no cumple para ese camino específico.

Prueba que lo cubre hoy: `tests/integration/revenue/night-audit-scheduler.spec.ts:
99-125` ("lock por hotel EN PROCESO") solo demuestra el guardarraíl `inFlight` en
memoria de UNA sola instancia de `NightAuditScheduler` — la propiedad que realmente
importa (dos instancias/procesos distintos sobre la misma BD) nunca se prueba.

### [ALTO] `PostgresApprovalQueue.decide()` no bloquea la fila de la aprobación: la transición a "aprobada" es un check-then-act sin lock
`packages/agent-core/src/postgresApproval.ts:153-207`: `fetchRowOrThrow` (SELECT
simple) → `loadConfirmations` (SELECT) → `insertConfirmation` (INSERT) → `UPDATE
... set status='aprobada' ... where id=$1` (línea 201-204, **sin** `and
status='pendiente'`) → sin ningún `pg_advisory_xact_lock` ni `SELECT ... FOR UPDATE`.
Compárese con `request()` (líneas 85-98 del mismo archivo), que sí toma
`lock_agent_approval_key()`, y con `mark_charge_reversed()`
(`packages/db/migrations/0030_folio_engine.sql:44-51`), que sí usa `UPDATE ... WHERE
reversed_by IS NULL` como guarda condicional — el patrón correcto existe en el mismo
código base, pero no se aplicó aquí.

Escenario: un ticket de mantenimiento con `is_money=true`, `required_confirmations=2`,
ya con la confirmación del gm. Dos confirmaciones finales del owner llegan por dos
canales casi simultáneos (panel web y botón de WhatsApp, cada uno con su propia
transacción independiente vía `dbSession`/`withAppSession`) — o simplemente un doble
clic/reintento de red del mismo owner sobre el mismo botón. Si ambas alcanzan a leer
`status='pendiente'` antes de que cualquiera comitee su `UPDATE`, ambas insertan su
confirmación, ambas calculan `aprobaciones >= required_confirmations`, y ambas ejecutan
`tool.run()` vía `apps/api/src/lib/aprobacionEjecutor.ts:48-67` (`if (decided.status
!== "aprobada") return {...}` — de lo contrario corre la tool). Para
`autorizar_gasto_mantenimiento` el efecto es un `UPDATE` idempotente (sin daño
observable), pero para `enviar_mensaje_whatsapp_plantilla` (mismo mecanismo de
aprobación, `effect:"external"`) sería un envío real duplicado al huésped, y para
cualquier tool de dinero futura que haga un `INSERT` sería un cargo duplicado.

Intento de reproducción propio: disparé 5 veces `Promise.all` de dos POST concurrentes
a `/hoteles/:hotelId/aprobaciones/:id/decidir` con la misma segunda confirmación
(owner) sobre una aprobación de mantenimiento con la primera confirmación (gm) ya
comiteada. En los 5 intentos, la segunda llamada llegó *después* de que la primera ya
había comiteado su `UPDATE` (recibió 409 "ya no está pendiente", 1 sola fila de
confirmación nueva, 1 sola ejecución) — no logré ganar la ventana de la carrera con dos
llamadas del mismo proceso de prueba sobre `embedded-postgres` local (latencia
demasiado baja/uniforme para que ambas cadenas de `await` se entrelacen en el punto
exacto). Esto **no** descarta el hallazgo: la ausencia de lock es real y verificada por
lectura directa (no hay ningún guardarraíl, a diferencia de todos los demás caminos de
dinero de este mismo código), y el escenario con dos canales físicamente distintos
(WhatsApp vs. panel, con latencia de red real de por medio) tiene una ventana mucho más
ancha que la que pude forzar en proceso. Lo marco ALTO, no CRÍTICO, precisamente porque
no logré demostrarlo empíricamente pese a intentarlo.

Causa raíz probable: `decide()` no reutiliza el mismo patrón de `UPDATE ... WHERE
status='pendiente'`/lock que sí protege `mark_charge_reversed()` y
`night_audit_claim()` en el resto del código.

### [ALTO] Una aprobación ya "aprobada" se re-ejecuta si el agente vuelve a proponer la misma tool dentro del TTL, sin nueva confirmación humana
`packages/agent-core/src/postgresApproval.ts:100-110` (`request()`): la búsqueda de una
solicitud existente (`where hotel_id=... and tool_name=... and input_hash=... and
requested_by=... and expires_at > now() order by requested_at desc limit 1`) **no
filtra por `status`** — devuelve la fila más reciente sin importar si quedó
`pendiente`, `aprobada` o `rechazada`. En `packages/agent-core/src/runner.ts:378-421`,
cada vez que el modelo propone la misma tool con el mismo input dentro del TTL (15 min
por defecto), el `AgentRunner` llama `approvalQueue.request(...)` de nuevo; si la fila
existente ya tiene `status==='aprobada'` (código: `if (approval.status !== "aprobada")
{ ...pendiente...; continue; }` — es decir, si SÍ es "aprobada" cae directo a `const
result = await tool.run(ctx, parsed.data);`, línea 421), la tool se ejecuta de nuevo
**sin pasar otra vez por una decisión humana**, y sin ninguna marca de "esta aprobación
ya se consumió".

Verifiqué el efecto concreto para `enviar_mensaje_whatsapp_plantilla`
(`packages/agent-core/src/tools/messagingTools.ts:78`): `clientMessageId =
\`${ctx.requestId}:${input.templateName}:${randomUUID()}\`` — un UUID **nuevo** en cada
llamada a `tool.run()`, así que el dedupe interno del adaptador de WhatsApp (por
`clientMessageId`) no puede detectar que es la "misma" ejecución. Escenario: el modelo
propone enviar la plantilla de oferta de upsell a un huésped, la solicitud recibe
aprobación humana, y el mismo agente (u otro turno de la misma conversación, o un
reintento del cliente HTTP sobre `/agentes/:agente/ejecutar` — que no exige
`Idempotency-Key`, `apps/api/src/routes/agentes.ts:63-72`) vuelve a proponer
exactamente la misma tool+input dentro de los 15 minutos: `request()` devuelve la fila
ya aprobada, y el runner reenvía el mensaje real al huésped una segunda vez.

Consecuencia: efecto duplicado hacia el huésped (mensaje repetido, sin control), y para
cualquier tool de dinero con efecto no-idempotente (a diferencia de la única tool de
dinero actual, que hace un `UPDATE` idempotente) sería un cargo duplicado real.

Causa raíz probable: `request()` reutiliza cualquier solicitud vigente por
`(hotel,tool,input_hash,requestedBy)` sin distinguir "todavía pendiente" de "ya
decidida", documentado como comportamiento intencional en
`tests/unit/agent-core/runner.spec.ts:222-263` mirando solo la primera ejecución, sin
un segundo test que dispare una segunda corrida independiente sobre la misma
aprobación ya "aprobada".

### [ALTO] El endpoint autenticado de aprobaciones confía en el `role` que declara el cliente, no en el rol real de sesión — vacía la exigencia de "dos roles distintos" de GOB-026
`apps/api/src/routes/aprobaciones.ts:17-20` (`role: z.string().trim().min(1).max(60)
.optional()`, sin validar contra `hotel_staff`) y línea 139 (`role: body.role ??
c.get("hotelRole")`) — si el cliente **envía** `role` en el body, ese valor arbitrario
gana sobre el rol real derivado de la sesión (`c.get("hotelRole")`, que sí viene de
`hotel_staff` vía `requireHotelMembership`).

`packages/agent-core/src/postgresApproval.ts:187-197` exige que la segunda confirmación
de dinero tenga un **rol** distinto al de la primera (`yaConfirmoEsteRol`), justo para
impedir que dos personas con el mismo puesto (dos co-propietarios `owner`) se
autoaprueben cargos grandes sin un segundo nivel de mando real. Escenario: owner-1
confirma con `role` omitido (usa su rol real `"owner"`); owner-2 confirma enviando
`{"role":"gm"}` en el body — mintiendo sobre su propio rol — y `decide()` ve
`role="gm" !== "owner"`, pasa la validación de "rol distinto", y la aprobación de
dinero queda completada con dos personas del MISMO rol real. Contrasta con el camino de
WhatsApp (`apps/api/src/routes/aprobacionesWhatsapp.ts:70-92`), que sí resuelve el rol
consultando `hotel_staff` por el número de WhatsApp remitente, nunca del payload — el
panel autenticado es, en este punto puntual, menos estricto que el canal público.

Consecuencia: el control de doble-rol de GOB-026 (pensado para evitar que un solo nivel
jerárquico autorice gasto grande sin supervisión de otro nivel) se puede vaciar con un
campo de body que ningún test ejercita.

Causa raíz probable: `decidirSchema` acepta `role` como texto libre del cliente en vez
de ignorarlo siempre y usar únicamente `c.get("hotelRole")`.

### [ALTO] La reclamación de idempotencia del webhook de WhatsApp (aprobación por botón y mensajería entrante) se comitea en una transacción separada del efecto real: un fallo entre ambas pierde el evento para siempre
`apps/api/src/routes/aprobacionesWhatsapp.ts:61-96` y
`apps/api/src/routes/mensajeria.ts:126-179`: en ambos, el `insert into
idempotency_key` que reclama el `event_id` corre sobre `deps.engine.admin` — una
sentencia suelta, autocommiteada de inmediato, fuera de cualquier transacción — y
**solo después** se abre `deps.engine.withAppSession(...)` (una transacción nueva e
independiente) para ejecutar el efecto real (decidir la aprobación y correr la tool, o
insertar la conversación/mensaje). `packages/db/src/engines.ts:76-86` documenta
explícitamente que `engine.admin` está pensado para el runner de migraciones/seeds,
"nunca por el código de aplicación en runtime" — pero aquí sí se usa en runtime, para
una escritura real.

Escenario: el owner pulsa "aprobar" en WhatsApp sobre una aprobación de $4,800 MXN (2a
y última confirmación). El webhook comitea el `insert into idempotency_key` (evento ya
marcado como "reclamado"), y el proceso muere (OOM, redeploy, excepción no capturada en
otro punto del event loop) antes de que `withAppSession(...)` complete
`decidirYEjecutarAprobacion`. La aprobación queda `pendiente` en la base (nunca se
decidió), pero el `event_id` de ese clic ya está consumido: si Meta reintenta la
entrega del webhook con el mismo `event_id` (comportamiento normal de reintento de
webhooks), el segundo intento entra por `claim.rows.length === 0` → `{estado:
"duplicado"}` sin volver a intentar `decidirYEjecutarAprobacion`. El clic del owner se
pierde en silencio; la aprobación expira sola a los 15 minutos sin ningún error visible
para nadie. Exactamente el mismo patrón en `mensajeria.ts` pierde un mensaje entrante
real del huésped (el huésped ve su WhatsApp como "enviado" pero el hotel nunca lo
recibe, y un reintento de Meta con el mismo `event_id` tampoco lo recupera).

Consecuencia: falla silenciosa — el huésped o el staff creen que algo pasó (mensaje
enviado, aprobación decidida) y la base dice otra cosa, exactamente la pregunta que
ordena la sección "Sistema agéntico" de este encargo aplicada al canal de WhatsApp del
backend.

Causa raíz probable: usar `engine.admin` (fuera de transacción) para la reclamación de
idempotencia en vez de incluirla en la MISMA transacción que ejecuta el efecto (como sí
hace `apps/api/src/lib/idempotency.ts` para reserva/folio/pago, donde el `INSERT` de la
llave y la mutación de negocio viven en la misma transacción de sesión).

### [ALTO] El timbrado de CFDI y el cobro con tarjeta llaman al proveedor externo ANTES del commit local, protegidos solo por idempotencia en memoria de proceso (no durable)
`apps/api/src/routes/cfdi.ts:232-271` (`deps.cfdi.timbrar(...)` en la línea 232, con el
`insert into cfdi_emision` recién en la línea 245-271, misma transacción de request) y
`apps/api/src/routes/folios.ts:571-588` (`deps.payments.charge(...)` en la línea 572,
`insert into payment` en la 583-588). La única protección contra re-ejecutar la llamada
externa si el proceso muere entre la llamada y el commit es la idempotencia PROPIA del
adaptador — que hoy es, verificado por lectura directa:
`packages/mcp-servers/cfdi/src/adapters/fake-pac-adapter.ts:40` (`private readonly
byFolio = new Map<string, StampedRecord>()`) y
`packages/mcp-servers/payments/src/adapters/fake-payment-adapter.ts:34` (`private
readonly resultIdempotency = new InMemoryIdempotencyStore<PaymentResult>()`) — ambos
**en memoria del proceso Node**, no durables.

Escenario: el proceso de `apps/api` muere justo después de que `deps.cfdi.timbrar()`
devuelva un UUID fiscal válido pero antes de que el `COMMIT` de la transacción llegue a
completarse. Postgres revierte toda la transacción (ni `cfdi_emision` ni
`idempotency_key` quedan grabados). Al reiniciar el proceso (o si el balanceador enruta
el reintento a otra réplica), el `Map` en memoria nace vacío. El cliente reintenta con
la misma Idempotency-Key; como no hay fila comprometida, el handler llama de nuevo a
`deps.cfdi.timbrar()` como si fuera la primera vez.

Nota de honestidad: hoy esto es **latente, no explotable**, porque los adaptadores
reales (`packages/mcp-servers/cfdi/src/adapters/finkok-adapter.ts`,
`packages/mcp-servers/payments/src/adapters/stripe-adapter.ts`) son stubs que lanzan
`PortUnavailableError` sin credenciales (ADR-007) — no hay integración real construida
todavía. Y para el caso de pago con tarjeta, el `idempotencyKey` que se le pasa al
proveedor (`${orgId}:${folioId}:${idempotencyKey}`, `folios.ts:576`) es determinístico
a partir del Idempotency-Key del cliente, así que un proveedor real con idempotencia
server-side durable (Stripe/Conekta la tienen, 24h) probablemente absorbería el
reintento sin duplicar el cobro real — mitigante que no pude verificar porque no hay
adaptador real que probar (ADR-007). Para CFDI el mismo argumento es menos seguro: no
hay evidencia de que el PAC real garantice esa misma propiedad por `folio`. En ambos
casos, el patrón arquitectónico correcto ya existe en este mismo código para el caso
`payment.recorded`/`folio.closed` (insertar primero en `outbox` dentro de la misma
transacción del hecho de negocio, drenar después con reintentos vía
`apps/api/src/outbox/worker.ts`) pero no se aplicó a la llamada síncrona al PAC/PSP.

Prueba que lo cubre hoy: `tests/integration/cfdi/idempotencia-timbrado.spec.ts` y
`tests/integration/folio/pago-concurrente.spec.ts` prueban muy bien la concurrencia de
dos transacciones vivas en paralelo (el caso que sí pide este encargo), y pasan — pero
ningún test mata el proceso entre la llamada externa exitosa y el commit, que es
justamente la pregunta central de esta auditoría y no es reproducible con los
adaptadores Fake actuales (su "durabilidad" es, por diseño, memoria de proceso).

### [ALTO] Verificación pública "código de reserva + apellido" degradada a un solo factor real, agravada por un límite de tasa por IP trivialmente evadible
`packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:234-240`
(`cancel_reservation_public`) y `packages/db/migrations/0050_experience_catalog_and_
public_order.sql:144-150` (`order_experience_public`) verifican el apellido con
`position(lower(trim(_apellido)) in lower(v_guest_name)) = 0` — subcadena, no igualdad
— y `apps/api/src/routes/cancelacionPublica.ts:17` /
`apps/api/src/routes/experienciasPublicas.ts:22` validan `apellido:
z.string().trim().min(1)`, sin longitud mínima real. Un `apellido: "a"` (o cualquier
letra común) pasa la verificación para casi cualquier `full_name`, neutralizando el
"segundo factor" que REQ-RES-005 exige junto con el `confirmation_code`.

Esto se agrava con `apps/api/src/middleware.ts:30-32` (`clientIp`): toma
`x-forwarded-for` sin validar que la request venga de un proxy de confianza —
`apps/api/src/server.ts` sirve HTTP directo con `@hono/node-server`, sin ningún
`trust proxy` documentado. Como `ipRateLimit` usa ese valor como clave del bucket
(`ip:${ip}`), un solo atacante desde un solo host puede rotar el header en cada
intento y obtener un bucket de rate-limit nuevo cada vez, sin necesitar IPs reales
distintas — más grave que la deuda ya conocida ("in-memory, no compartido entre
instancias", `docs/auditoria-1/correccion-seguridad.md`), porque aquí ni siquiera hace
falta escalar horizontalmente para romper el límite.

Escenario combinado: quien obtenga el `confirmation_code` de una reserva por cualquier
canal semi-público (voucher impreso, pantalla de recepción, agencia de viajes) puede
cancelarla o generar pedidos con cargo a su folio sin conocer el apellido real del
huésped, y sin que el límite de 300 req/min/IP lo frene de verdad si decide probar
varios códigos.

Causa raíz probable: `min(1)` en vez de una longitud mínima razonable para el apellido,
y `clientIp()` sin lista de proxies de confianza ni cabecera firmada.

Prueba que lo cubre hoy: `tests/adversarial/cancelacion-identidad.spec.ts` prueba el
"match parcial" como comportamiento intencional (tolerar `"hernández"` vs. `"Ana
Hernández"`), pero no cubre el caso límite de un apellido de un carácter; ningún test
de rate-limit prueba la rotación de `X-Forwarded-For`.

## Hallazgos MEDIO

### [MEDIO] "Fuera de servicio" en housekeeping/mantenimiento no reduce el inventario vendible
`apps/api/src/routes/housekeeping.ts:194-208` y
`packages/agent-core/src/tools/housekeepingTools.ts:169-173` escriben
`room.status`/`room.housekeeping_status = 'fuera_de_servicio'`, pero
`book_availability()` (`packages/db/migrations/0004_room_inventory.sql:98-120`)
descuenta inventario solo contra `availability.total_rooms/booked_rooms` por
`room_type_id`+fecha, sin ninguna referencia a `room.id`/`room.status`. Marcar una
habitación físicamente inutilizable (inundación, AC roto) no reduce el conteo
vendible de ese tipo de habitación: el sistema puede seguir confirmando reservas hasta
agotar el conteo agregado, sin excluir la unidad inhabilitada — riesgo real de vender
una habitación que no se puede entregar el día del check-in. Puede ser una limitación
de diseño conocida (inventario a nivel de tipo, sin asignación de habitación física
todavía), pero el efecto observable es que la escritura de "fuera de servicio" es
decorativa respecto al motor de venta, justo la pregunta que ordena este rubro
aplicada a inventario físico.

### [MEDIO] El mensaje de error de MRZ inválida filtra el número de documento en texto plano en la respuesta pública 400
`packages/domain-hotel/src/mrz.ts:58-65,105,110-112`: el mensaje de
`InvalidMrzError` incluye el campo `field` (número de documento u otros campos de la
línea 2 de la MRZ) sin enmascarar; en el dígito de control "compuesto final" (línea
112) el mensaje incluye la concatenación completa de documento+fechas+número personal.
`apps/api/src/routes/checkinOnline.ts:107-109` (ruta **pública**, sin sesión) y
`apps/api/src/routes/identidad.ts:85-87` reenvían ese `err.message` literal en el
cuerpo 400 vía `Errors.validation(...)`, que sí pasa el mensaje crudo (a diferencia del
500 genérico que sí filtra todo detalle interno). Contradice el invariante que el
propio módulo de bóveda documenta ("la base de datos solo almacena bytes opacos... el
resto del sistema solo ve `identity_ref`"): un typo al transcribir la MRZ hace que el
número de pasaporte en claro viaje en una respuesta HTTP pública, capturable por
herramientas de error-tracking o soporte al cliente, sin pasar por el registro de
auditoría que sí exige `read_identity_vault_document()` para cualquier revelación.

### [MEDIO] Reverso de cargo que pierde una carrera legítima devuelve 500 genérico y dispara la alerta de ADR-008 sin necesidad
`packages/db/migrations/0030_folio_engine.sql:44-51` (`mark_charge_reversed`, `raise
exception 'reverso_invalido...'` si el cargo ya fue reversado) y
`apps/api/src/lib/errors.ts:45-74` (`toErrorBody` no reconoce el prefijo
`reverso_invalido` — cae al 500 genérico). Dos reversos concurrentes legítimos sobre el
mismo cargo (dos operadores, o un doble clic) dejan al segundo con un 500 en vez de un
409 explicable, y ese 5xx en `/folios` dispara `alerta_camino_dinero`
(`apps/api/src/app.ts:111-129`) para una condición de carrera esperada y benigna (los
datos quedan correctos: nunca hay dos reversos), generando ruido/alert-fatigue en el
camino de dinero. No hay fuga de stack trace (el mensaje al cliente sigue siendo
genérico), solo un código de estado y una alerta equivocados.

### [MEDIO] Presupuesto mensual por (hotel, agente): condición de carrera check-then-act sin lock
`apps/api/src/routes/agentes.ts:330-339`: `costoDelMes()` (SELECT agregado) se compara
contra `config.monthlyCeilingUsd` sin ningún `SELECT ... FOR UPDATE`/advisory lock (a
diferencia de `lock_agent_approval_key()` que sí protege la creación de aprobaciones).
Dos ejecuciones casi simultáneas del mismo agente/hotel cerca del techo mensual pueden
ambas leer `restante > 0` y ambas gastar hasta ese remanente de forma independiente,
superando el techo configurado en conjunto. Es control de costo interno (no dinero del
huésped), pero contradice el comentario de cabecera del archivo ("nunca se llama al
proveedor 'gratis' cuando ya no queda presupuesto").

## Hallazgos BAJO

### [BAJO] Fallback silencioso de la clave de cifrado de la bóveda de identidad fuera de `NODE_ENV==="production"` exacto
`apps/api/src/lib/identityEncryption.ts:25-44`: mismo patrón ya usado (y aceptado en la
ronda 1) para `JWT_SECRET` — sin default en producción estricta, con clave de
desarrollo fija (`DEV_ONLY_KEY_HEX`) fuera de ella. La comparación es un string exacto
a `"production"`; cualquier entorno real con `NODE_ENV` distinto (staging, typo, sin
definir) que además olvide `IDENTITY_VAULT_ENCRYPTION_KEY` cifra documentos de
identidad reales con una clave pública en el repositorio, sin ningún error. El patrón
en sí ya fue revisado favorablemente para JWT; lo distinto aquí es que el dato en
juego es PII de identificación oficial con obligaciones LFPDPPP explícitas
(REQ-SEG-014), lo que hace el mismo patrón más costoso si falla.

### [BAJO] El camino de agentes/aprobaciones queda fuera de la alerta estructurada del "camino del dinero"
`apps/api/src/lib/moneyAlert.ts:7` (`MONEY_PATH_MARKERS = ["/pagos", "/cargos",
"/cfdi", "/folios", "/reservas"]`) no incluye `/agentes` ni `/aprobaciones`, pese a que
ambos pueden ejecutar `autorizar_gasto_mantenimiento` (dinero real) y
`enviar_mensaje_whatsapp_plantilla`. Un 5xx durante cualquiera de los escenarios de
arriba no dispara `alerta_camino_dinero`, reduciendo la probabilidad de detección por
logs.

### [BAJO] `registrar_evento_roi`: montos y "confianza" enteramente generados por el modelo, sin verificación cruzada
`packages/agent-core/src/tools/roiTools.ts:22-32,49-50`: hasta USD 10,000,000 por
evento, `effect:"write"` (no `money`), sin `needsApproval`, sin tope de
frecuencia/día, y `referenciaCodigo` es explícitamente "identificador de negocio, no
FK" — no hay verificación contra una reserva/folio/tarea real. Decisión de diseño
consciente (el propio código dice "no habilita ningún cobro por resultado"), pero deja
el reporte de ROI que el dueño del hotel usa para evaluar el producto abierto a
números alucinados o inflados por el propio agente sin ningún control server-side.

### [BAJO] Fallback de proveedor LLM probado en unitarias pero nunca conectado en el punto de construcción real
`packages/agent-core/src/runner.ts:27` (`fallbackProvider`) tiene su lógica probada en
`tests/unit/agent-core/runner.spec.ts:538`, pero
`apps/api/src/routes/agentes.ts:405-426` (`new AgentRunner({...})`, el único punto real
de construcción) nunca lo pasa. Hoy cualquier `ProviderTransientError` termina la
corrida en `error_proveedor` sin conmutación real — deuda de que la mitigación de
disponibilidad de REQ-INT-00x no está conectada, no un bug de doble conteo (revisé el
mecanismo en sí y no encontré re-atribución de costo incorrecta si algún día se
conecta).

## Lo que revisé y está bien

- **Overbooking bajo concurrencia real** sigue cerrado: `book_availability()`
  (`packages/db/migrations/0004_room_inventory.sql:83-125`) con
  `pg_advisory_xact_lock`, probado contra `embedded-postgres` real en
  `tests/integration/reservas/overbooking-controlado.spec.ts`.
- **Idempotencia de reserva/cargo/pago por clave+cuerpo dentro de la MISMA
  transacción**: `apps/api/src/lib/idempotency.ts:38-94` — el `INSERT ... ON
  CONFLICT` de la llave y la mutación de negocio viven en la misma transacción de
  sesión, dando serialización correcta bajo concurrencia real; verificado en
  `tests/adversarial/idempotencia-concurrente.spec.ts` y
  `tests/integration/folio/pago-concurrente.spec.ts` con dos conexiones físicas
  simultáneas contra `embedded-postgres`, no PGlite.
- **Idempotencia de CFDI a nivel de fila en BD**: índice único parcial
  `cfdi_emision_folio_hospedaje_unq`/`cfdi_emision_payment_unq`
  (`packages/db/migrations/0032_cfdi_emision.sql:37-40`) + patrón `INSERT ... ON
  CONFLICT DO NOTHING` con fallback `SELECT` — nunca hay dos filas de
  `cfdi_emision` para el mismo folio, verificado con concurrencia real en
  `tests/integration/cfdi/idempotencia-timbrado.spec.ts`.
- **`ToolContext` resuelto en servidor, nunca del modelo ni del body**:
  `buildToolContext()` (`packages/agent-core/src/context.ts:61-75`) exige
  `orgId`/`hotelId`/`requestId`/`actor.id` desde `ServerSession`;
  `assertNoIdentifierFields()` (`packages/agent-core/src/tool.ts:91-145`) rechaza
  estructuralmente cualquier campo de tool que matchee
  `org.?id|hotel.?id|tenant.?id|guest.?id|...`. `ejecutarSchema` de `agentes.ts` es
  `.strict()`.
- **`needsApproval` forzado por tipo para tools `money`/`external`**
  (`packages/agent-core/src/tool.ts:149-167`, GOB-026) y bloqueo de paralelismo de
  dinero dentro de una misma ronda de conversación (`runner.ts:266-283`).
- **Doble confirmación con roles distintos para dinero** en el caso SECUENCIAL (no
  concurrente, ver hallazgo ALTO arriba): probado con sesiones RLS reales owner+gm en
  `tests/integration/agent-core/postgres-approval-queue.spec.ts:103-146` y
  `tests/integration/api/housekeeping-mantenimiento.spec.ts:125-167`.
- **Ningún endpoint revisado toma `hotel_id`/`tenant_id`/`org_id` del body**:
  `reservas.ts`, `folios.ts`, `cfdi.ts`, `housekeeping.ts`, `mantenimiento.ts`,
  `aprobaciones.ts`, `mensajeria.ts`, `agentes.ts` usan consistentemente
  `c.req.param("hotelId")` validado por `requireHotelMembership` contra la sesión
  real.
- **Sin fuga de stack trace ni mensaje interno de Postgres al cliente en 5xx**:
  `apps/api/src/lib/errors.ts:45-74` colapsa cualquier error no reconocido a
  `{code:"internal_error", message:"Ocurrió un error interno."}`; revisé
  `reservas.ts`, `folios.ts`, `cfdi.ts`, `night-audit.ts`, `housekeeping.ts`,
  `mantenimiento.ts`, `aprobaciones*.ts`, `mensajeria.ts`, `agentes.ts`,
  `cancelacionPublica.ts`, `checkinOnline.ts`, `identidad.ts` sin encontrar ningún
  `.stack` ni error crudo reenviado en una respuesta JSON (la única excepción es el
  hallazgo MEDIO de MRZ arriba, que filtra un campo de dominio, no un stack).
- **Check-in online de un solo uso, atómico**:
  `packages/db/migrations/0054_checkin_online.sql:90-174`
  (`complete_checkin_public`) marca el token consumido DESPUÉS de todas las
  escrituras, dentro de una sola transacción PL/pgSQL — un crash a medio camino
  revierte todo junto, nunca deja un token quemado sin efecto.
- **Bóveda de identidad sin acceso directo**: `identity_vault`
  (`packages/db/migrations/0051_identity_vault.sql:22-44`) tiene RLS sin ninguna
  policy/GRANT a `authenticated`; único acceso vía dos funciones `SECURITY DEFINER`,
  verificado en `tests/adversarial/boveda-identidad.spec.ts`. IV aleatorio por fila,
  AES-256-GCM autenticado (alteración de 1 byte falla al descifrar), retención de 30
  días verificada end-to-end con reloj simulado.
- **Precio de pedido público siempre recalculado en servidor**:
  `order_experience_public` (`packages/db/migrations/0050_experience_catalog_and_
  public_order.sql:107-219`) no acepta ningún parámetro de precio del cliente,
  verificado en `tests/adversarial/rpc-security-definer.spec.ts:84-136`.
- **Idempotencia real de webhook por `event_id` en el camino feliz** (sin crash
  intermedio): `aprobacionesWhatsapp.ts:61-68` y `mensajeria.ts:126-135`, probado en
  `tests/integration/contracts/whatsapp/aprobaciones-boton.spec.ts` y
  `tests/adversarial/housekeeping-mantenimiento-mensajeria.spec.ts` — un replay
  legítimo del mismo evento nunca reprocesa (el hallazgo ALTO de arriba es
  específicamente sobre el camino donde el primer intento se interrumpe a medias,
  no probado por estos tests).
- **Aislamiento multi-tenant/multi-hotel** en housekeeping/mantenimiento/night-audit:
  probado con RLS real (sesión directa, sin pasar por la API) en
  `tests/adversarial/housekeeping-mantenimiento-mensajeria.spec.ts` y con 403
  explícito por rol en `tests/integration/revenue/night-audit.spec.ts` (housekeeping
  no puede disparar/leer night audit).
- **Firma HMAC obligatoria en ambos webhooks públicos de WhatsApp** (aprobación por
  botón y mensajería), con secreto por hotel — firma incorrecta o ausente → 401,
  probado en `tests/adversarial/housekeeping-mantenimiento-mensajeria.spec.ts`.

## Lo que NO alcancé a revisar

- **PMS/pasarela de pago/CFDI/WhatsApp/voz reales**: como exige el encargo, no ejecuté
  ni simulé ninguna llamada real (ADR-007, pendientes de credenciales); el hallazgo
  ALTO sobre CFDI/pago solo pude documentarlo contra el comportamiento de los
  adaptadores simulados, no contra un PAC/PSP real.
- **No logré demostrar empíricamente el hallazgo ALTO de `PostgresApprovalQueue.
  decide()`** pese a 5 intentos de reproducción con dos requests concurrentes del
  mismo proceso de prueba — documentado explícitamente en el propio hallazgo, no
  oculto. Un intento con dos procesos de servidor reales y latencia de red genuina
  (dos réplicas, o WhatsApp vs. panel con delay real) tiene una ventana de carrera
  más ancha que la que pude forzar aquí.
- **`packages/agent-core/src/tools/*` fuera de mensajería/mantenimiento/ROI**: no
  revisé `crear_tarea_housekeeping` con la misma profundidad adversarial (su efecto
  no es dinero ni externo irreversible, quedó fuera de la prioridad del tiempo
  disponible).
- **`apps/api/src/routes/hoteles.ts`, `resumen.ts`, `backOffice.ts`,
  `conocimientoLocal.ts`, `tarifas.ts`, `quotes.ts`, `disponibilidad.ts`,
  `huespedes.ts`**: los leí para confirmar que no toman `hotel_id` del body ni
  filtran stack traces, pero no los sometí a la misma profundidad adversarial que
  night-audit/no-show/aprobaciones/CFDI por no tocar directamente dinero/inventario
  o por estar fuera del foco explícito de "código nuevo desde auditoría 1" que pidió
  el encargo.
- **Carga real de conexiones concurrentes / agotamiento del pool** bajo tráfico alto:
  no construí una prueba de carga (fuera de "no ejecutar nada pesado sin
  autorización" del encargo).
- **El entorno de auditoría no es completamente estático**: `git status --porcelain`
  mostró capturas `.png` de `tests/e2e/screenshots/` modificadas al llegar (de una
  corrida de Playwright anterior a esta sesión, no generada por mí) — no relacionadas
  con el código de backend, las dejé tal cual, sin tocarlas.
