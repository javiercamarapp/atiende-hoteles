# Rendimiento y costo (incl. costo LLM por hotel) — auditoría 2

**Nota: 4/10** (sin ronda anterior — primera auditoría de este rubro, nota línea base).

El riesgo mayor hoy: bajo carga concurrente realista (≥20 requests simultáneos, el
default de producción de `poolMax`), `GET /hoteles/:hotelId/reservas` colapsa el pool de
conexiones de Postgres compartido por **todo el proceso** y arrastra consigo rutas sanas
no relacionadas (`/disponibilidad`) — no es una desaceleración, es una caída total y
verificada de la API completa para cualquier hotel que comparta ese despliegue.

Todas las mediciones de este documento son reales, tomadas dentro del snapshot
(`.claude/worktrees/auditoria-2-snapshot`) contra un `embedded-postgres` (Postgres 18.4)
real levantado por mí con datos sembrados a escala (2 hoteles × 100 habitaciones × 365
noches × 2,000 reservas para el `EXPLAIN ANALYZE`; un hotel adicional para los
experimentos de concurrencia/aislamiento). Nada de esto es estimado ni de memoria.

## Hallazgos

### [CRÍTICO] `GET /hoteles/:hotelId/reservas` duplica su propia sesión de BD y bajo carga colapsa el pool compartido de TODO el despliegue (efecto cruza a otros hoteles)
`apps/api/src/routes/reservas.ts:137-148`
```
app.use("/hoteles/:hotelId/reservas", authMiddleware(...), dbSession(deps.engine), requireHotelMembership("hotelId"));
app.use("/hoteles/:hotelId/reservas/*", authMiddleware(...), dbSession(deps.engine), requireHotelMembership("hotelId"));
```
El mismo patrón exacto está en `apps/api/src/routes/huespedes.ts:19-25` para
`GET /hoteles/:hotelId/huespedes`.

Escenario: Hono resuelve el comodín `"/reservas/*"` contra la ruta EXACTA
`"/reservas"` (verificado con una réplica mínima de Hono 4.13.7: para
`GET /hoteles/abc/reservas`, ambos `app.use` registrados arriba se disparan, `count`
llega a 2). Eso significa que `authMiddleware` + `dbSession` + `requireHotelMembership`
corren **dos veces** para la misma request — `dbSession` abre DOS transacciones/sesiones
(`engine.withAppSession`, cada una `pool.connect()`) anidadas para un solo
`GET /reservas`, es decir, consume **2 conexiones del mismo `pg.Pool`** por request en
vez de 1.

Reproduje esto con datos reales: sembré 1 hotel, 5 tipos de habitación, 100
habitaciones, disponibilidad/tarifa de 365 días, y until 1,000 reservas, y arranqué la
app real (`createApp`) contra `embedded-postgres` con el `poolMax` **por defecto de
producción** (`packages/db/src/engines.ts:209`, `options.poolMax ?? 20`, nunca
sobrescrito por `apps/api/src/db.ts`/`server.ts`). Con 50 requests concurrentes a
`GET /hoteles/:hotelId/reservas`:

- concurrencia 5/10: 0 errores (51-74ms).
- concurrencia **20 (== poolMax)**: **20/20 requests fallan con 500**, las 20 tardan
  ~5,012-5,015ms (el `connectionTimeoutMs` por defecto de `pg.Pool`, también 5,000ms,
  `engines.ts:209`).
- concurrencia 30 y 50: 100% de fallos, mismo techo de ~5,000-5,113ms.

Descarté que fuera la consulta SQL: la MISMA consulta ejecutada 20-50 veces
concurrentes directo contra `engine.withAppSession()` (sin Hono/JWT/ruta de por medio)
resuelve en 1-6ms totales, con y sin `LIMIT`. El cuello de botella es exclusivamente la
doble apertura de sesión por request en la capa de ruteo: con 20 requests concurrentes
cada una reteniendo una conexión "externa" mientras espera adquirir la "interna" del
MISMO pool de 20, ninguna puede completar — auto-bloqueo de pool clásico por
adquisición anidada, resuelto solo cuando el timeout de 5s libera conexiones externas.

Y esto **no se queda en `/reservas`**: como el pool (`pg.Pool` de `EmbeddedPostgresEngine`)
es UNO SOLO por proceso, compartido por todas las rutas de todos los hoteles del mismo
despliegue, lo verifiqué lanzando 20 `GET /reservas` + 5 `GET /disponibilidad` (ruta
sana, sin doble registro) EN PARALELO contra el mismo `engine`: las 5 requests de
`/disponibilidad` también fallaron 5/5 con el mismo timeout de ~5,006-5,007ms, pese a
que su propia consulta ejecuta en <1ms y su ruta no tiene el bug.

Consecuencia: cualquier staff (frontdesk, reservaciones, gerencia) de CUALQUIER hotel
que comparta el despliegue puede tumbar la disponibilidad, folios, agentes, etc. de
TODOS los demás hoteles simplemente abriendo la pantalla de reservas con tráfico
concurrente normal de temporada alta (varias pestañas de recepción, un refresh
automático, o simplemente 20 miembros de staff en varios hoteles cargando la lista casi
al mismo tiempo) — sin ningún ataque, con la configuración por defecto documentada en el
propio código. Es funcionalmente una fuga de disponibilidad entre hoteles del mismo
despliegue (no de datos, de servicio), y el fallo es silencioso: 500 genérico, sin
ninguna señal de qué pasó, ni una alerta específica de agotamiento de pool.
Causa raíz probable: comodín `"/reservas/*"` registrado ADEMÁS del path exacto
`"/reservas"`, cuando Hono ya hace matching de rutas exactas — el comodín solo debería
cubrir sub-recursos (`/reservas/:id`, `/reservas/:id/transicion`, etc.), nunca el propio
listado.

### [ALTO] REQ-AGT-005 (effort bajo en voz/WhatsApp + prefijo cacheable ≥1,024/4,096 tokens) no existe en el camino real, y el canal se descarta en silencio
`apps/api/src/routes/agentes.ts:66` (schema acepta `canal: "voz"|"texto"`), `apps/api/src/routes/agentes.ts:412` (`temperature: ROLE_PARAMS[def.role].temperature`), `packages/agent-core/src/roles.ts:63-68` (`roleParamsForChannel`), `packages/agent-core/src/provider.ts:40-54` (`LlmCompleteParams`)

Escenario: un huésped llama por voz al agente `recepcion_virtual`. `POST
/hoteles/:hotelId/agentes/recepcion_virtual/ejecutar` recibe `canal: "voz"` en el body
(validado por `ejecutarSchema`, `agentes.ts:66`) — pero ese valor **nunca se lee** en
ningún punto posterior de la ruta (confirmado por `grep`: ni `body.canal` ni
`roleParamsForChannel(...)` aparecen fuera de su propia definición). La llamada al
`AgentRunner` usa directamente `ROLE_PARAMS[def.role].temperature` (línea 412), que es
el valor BASE del rol (`canal: {temperature: 0, effort: "medium"}`,
`roles.ts:45`), nunca el valor con `effort: "low"` que `roleParamsForChannel` calcula
específicamente para `role: "canal"` + `channel: "voz"` (`roles.ts:63-68`, función que
existe y está exportada pero es código muerto — cero llamadores en todo `apps/api`).
Peor: aunque se llamara, no habría dónde ponerlo — `LlmCompleteParams`
(`provider.ts:40-54`) no tiene ningún campo `effort` ni `cache_control`; el proveedor
real (cuando exista, hoy `EnvProvider` declara `ProviderNotImplementedError`) no
recibiría jamás la instrucción de bajar el esfuerzo de razonamiento en voz, ni ningún
marcador de prefijo cacheable.

Consecuencia: el día que `EnvProvider` tenga integración real (ADR-007 pendiente), TODAS
las llamadas de canal (voz y texto) correrán a `effort: "medium"` — más caras y más
lentas que el `effort: "low"` que REQ-AGT-005 exige específicamente para voz, con
impacto directo en el SLO de latencia de voz (REQ-AGT-016, TTFT <600ms p50) y en el
costo por hotel (LLM-026, banda USD 27-158/mes: cada llamada de voz gastará más tokens
de razonamiento de los presupuestados). Además, sin ningún mecanismo de prefijo
cacheable, cada llamada paga el precio completo (sin el ~90% de descuento de caché) del
prefijo sistema+catálogo+tools en cada turno — el propio comentario de archivo de
`pricing.ts` reconoce el patrón de contabilidad de costo, pero no hay nada que
active el descuento. Esto es silencioso: no hay ninguna prueba, error de tipos, ni log
que señale que el canal se ignora — confirmado también por la ausencia total de
`tests/unit/agent-core/prefijo-cacheable.spec.ts` (referenciado como pendiente en
`docs/ACEPTACION.md:246` pero el archivo no existe en el árbol).
Causa raíz probable: `roleParamsForChannel` se agregó (aud-1 agentico.md MEDIO) pero
nunca se conectó al único punto de invocación real en `apps/api`.

### [MEDIO] `POST /hoteles/:hotelId/reservas` hace un round-trip secuencial a `book_availability()` por cada noche de la estadía, en vez de una sola llamada agregada
`apps/api/src/routes/reservas.ts:250-259`
```ts
for (const night of nights) {
  await db.query("select * from public.book_availability($1, $2, $3, 1);", [hotelId, body.roomTypeId, night]);
}
```
Escenario: una reserva de 14 noches ejecuta 14 llamadas `await` secuenciales a
`book_availability()`, cada una con su propio `pg_advisory_xact_lock` (correctamente
acotado a `(hotel_id, room_type_id, date)` — confirmé en
`packages/db/migrations/0004_room_inventory.sql:68-77` que el lock NO es global, así que
esto no es un problema de contención entre reservas distintas). Medí 7 llamadas
secuenciales reales: 3ms total (~0.4ms/llamada) contra `embedded-postgres` local — en un
Postgres gestionado real (RDS/Supabase) con latencia de red de 1-3ms por round-trip,
esa misma reserva de 14 noches gastaría 14-42ms solo en ida-y-vuelta de red, tiempo en
el que la transacción completa de la reserva (y su conexión del pool) permanece abierta.
Consecuencia: escala linealmente con la duración de la estadía (una reserva de 30 noches
= 30 round-trips), y bajo el hallazgo CRÍTICO de arriba (pool ya bajo presión) cada
milisegundo que una transacción de escritura retiene su conexión agrava el
agotamiento del pool compartido. No es un bug de corrección — cada noche se valida
correctamente — es exactamente el patrón que el rubro pide detectar: "una consulta de
disponibilidad dentro de un bucle por noche/habitación en vez de una sola consulta
agregada".
Causa raíz probable: no existe una variante de `book_availability` que reciba un rango
de fechas y decremente/valide todas las noches en una sola sentencia (p.ej. una CTE con
`generate_series` + `UPDATE ... FROM`).

### [MEDIO] `GET /hoteles/:hotelId/reservas` (y `/huespedes`) no paginan — devuelven TODA la tabla del hotel en una sola respuesta
`apps/api/src/routes/reservas.ts:150-163`, `apps/api/src/routes/huespedes.ts:27-40`

Escenario: ninguna de las dos rutas acepta ni aplica `limit`/`offset`. Con 1,000
reservas sembradas para un solo hotel, `GET /hoteles/:hotelId/reservas` devuelve las
1,000 filas completas (con `JOIN room_type`/`guest`/`folio`) en un solo `array` JSON —
confirmé con `EXPLAIN ANALYZE` que a esta escala el costo del lado de Postgres es
trivial (0.84ms), pero el patrón no tiene techo: un hotel con 3-5 años de operación
fácilmente acumula 15,000-50,000 reservas, y esa MISMA consulta seguirá intentando traer
la tabla completa cada vez que alguien abra la pantalla de reservas — degradación
silenciosa que empeora con cada mes de operación del hotel, sin ninguna alerta que lo
señale. `GET /hoteles/:hotelId/roi` sí implementa `limit 500` (`apps/api/src/routes/roi.ts`,
confirmado) y `GET /hoteles/:hotelId/back-office/cobros` está acotado al mes en curso —
ambas rutas de dinero SÍ tienen un techo; `reservas`/`huespedes` son las excepciones.
Consecuencia: el propio hallazgo CRÍTICO de arriba es más grave sobre esta ruta
precisamente porque no pagina — más filas por transacción retenida es más tiempo
reteniendo la conexión duplicada del pool.
Causa raíz probable: ninguna de las dos rutas fue diseñada con un límite por defecto ni
con parámetros de paginación en el schema de query.

### [MEDIO] `apps/web` no tiene code-splitting: 19 páginas en un solo chunk de 512.61 KB (151.91 KB gzip)
`apps/web/src/App.tsx:8-25`

Escenario: corrí `npm run build` real dentro del snapshot (`apps/web`, Vite 8.2.2). Las
19 páginas (`Reservas`, `Folios`(vía `BackOffice`), `Housekeeping`, `Mantenimiento`,
`Agentes`, `Mensajeria`, `Reputacion`, etc.) se importan de forma estática
(`App.tsx:8-25`, ningún `React.lazy`/`import()` dinámico en todo `apps/web/src`), así
que Vite las empaqueta en un solo archivo:
```
dist/assets/index-BkmbEiYa.js   512.61 kB │ gzip: 151.91 kB
```
Consecuencia: un huésped/staff que solo necesita `/login` o la pantalla de
`Disponibilidad` descarga y parsea el código completo de `Agentes.tsx`,
`BackOffice.tsx`, `Mensajeria.tsx`, etc., incluso si nunca los visita en esa sesión —
tiempo de carga inicial más alto del necesario, más notable en la conexión móvil de un
hotel con wifi de recepción mediocre (el escenario real del producto). Se degrada y se
nota, no falla.
Causa raíz probable: enrutado con importaciones estáticas en `App.tsx`, sin
`React.lazy(() => import(...))` por ruta.

### [BAJO] `GET /hoteles/:hotelId/reservas/:reservationId/folios` hace N+1 (2 queries por folio) dentro de la MISMA sesión
`apps/api/src/routes/folios.ts:200-216`

Escenario: para una reserva con folios divididos (principal + splits), el handler
itera `for (const f of rows) { charges = await loadCharges(...); payments =
await loadPayments(...); }` — 2 round-trips secuenciales por folio. El propio comentario
del archivo (línea ~211) documenta que esto es deliberado ("un solo cliente pg por
sesión... deben correr en SERIE, nunca concurrentes") para no violar el contrato de una
conexión por transacción. El impacto real es bajo porque el fan-out (folios por
reserva) rara vez pasa de 2-3, a diferencia de los N+1 de disponibilidad por noche
(hallazgo MEDIO de arriba) donde N puede ser 30+. Lo dejo como BAJO — deuda que cobra
factura solo si el producto empieza a soportar folios con muchas divisiones (grupos
grandes, facturación por habitación individual dentro de una reserva grupal).
Causa raíz probable: mismo patrón de "una query por fila padre" que el bucle de noches,
aquí acotado por el bajo fan-out típico de folios.

## Lo que revisé y está bien

- **Tabla de precios de `pricing.ts`** (`packages/agent-core/src/pricing.ts:17-21`)
  coincide EXACTAMENTE con los precios de lista oficiales vigentes hoy (verificado
  contra la skill `claude-api`, tabla cacheada 2026-06-24): `claude-sonnet-5`
  $2/$10 por MTok, `claude-haiku-4-5` $1/$5, `claude-opus-5` $5/$25 — sin desfase.
- **Atribución de costo correcta incluso con fallback de proveedor**
  (`packages/agent-core/src/runner.ts:205-213`): `estimateCostUsd()` se calcula con
  `completion.modelSlug` (el modelo que REALMENTE respondió), no con `opts.modelSlug`
  (el modelo solicitado) — si algún día se activa `fallbackProvider` y cambia de modelo
  a mitad de corrida, el costo se atribuye al modelo correcto. Este es exactamente el
  bug que Likida corrigió en `openrouter.ts` (§2.6) y aquí ya está bien desde el
  diseño, no como parche posterior.
- **Costo por hotel, no solo por corrida global** (`apps/api/src/routes/agentes.ts:109-128`,
  `packages/agent-core/src/agents.ts`): `agent_cost_mes(hotel_id, agent_name)`,
  `agent_run` y la métrica Prometheus `agent_cost_usd_total{hotel,agente}`
  (`apps/api/src/metrics.ts:38`) están todos agrupados por `hotel_id` — el rubro exige
  exactamente esto ("verificar que la contabilidad se agrupa por tenant_id, no solo por
  corrida global") y se cumple.
- **Corte de presupuesto ANTES de invocar al proveedor** (`apps/api/src/routes/agentes.ts:339-366`):
  si el techo mensual ya se agotó, NUNCA se llama al proveedor — se inserta un
  `agent_run` con costo 0 y se responde `presupuesto_agotado` de inmediato. Los techos
  configurados por agente (`agents.ts:67,90,110`: 45+8+15 = USD 68/mes) caen dentro de
  la banda LLM-026 (USD 27-158/mes) citada en `docs/referencia/01-blueprint-y-decision-llm.md:374`.
- **Advisory locks de disponibilidad correctamente acotados** (`packages/db/migrations/0004_room_inventory.sql:68-77`):
  `pg_advisory_xact_lock` sobre `hash(hotel_id:room_type_id:date)`, nunca un lock global
  — dos reservas de hoteles o tipos de habitación distintos jamás se serializan entre sí
  por este mecanismo.
- **Ningún documento de identidad se envía a un LLM** (`apps/api/src/routes/identidad.ts:1-9,20-25`):
  `documentImageBase64` se valida por Zod y se descarta, nunca se persiste ni se
  reenvía — el rubro pedía revisar "integraciones de imagen... sin redimensionar"; aquí
  la respuesta es que la imagen simplemente nunca llega a ningún modelo, lo cual es
  mejor que redimensionarla.
- **`GET /hoteles/:hotelId/roi` pagina con `limit 500`** (`apps/api/src/routes/roi.ts`)
  y **`GET /hoteles/:hotelId/back-office/cobros` está acotado al mes en curso**
  (`apps/api/src/routes/backOffice.ts:41-63`) — dos rutas de dinero que sí evitan el
  patrón de la lista completa sin techo.
- **`disponibilidad`/`disponibilidad/grid` no tienen el bug de doble middleware**
  (`apps/api/src/routes/disponibilidad.ts:24-35`): cada `app.use` registra un path
  literal distinto (`/disponibilidad` y `/disponibilidad/grid`), sin comodín que
  se superponga — confirmado que no hay doble ejecución aquí.
- **`Disponibilidad.tsx` (frontend) acota su propia grilla a una semana por vez**
  (`apps/web/src/pages/Disponibilidad.tsx:29-48`: `DIAS_POR_SEMANA = 7`,
  `inicioSemana(semanaOffset)`), no a un rango arbitrario — el caso de 365 días que usé
  para el `EXPLAIN ANALYZE` de esta auditoría es un escenario de estrés que el propio
  frontend no genera hoy; lo dejo documentado como línea base para cuando exista un
  consumidor (ej. sync de channel manager) que sí pida rangos largos.
- **Night audit scheduler con intervalo razonable** (`apps/api/src/jobs/nightAuditScheduler.ts:150`):
  `setInterval` de 15 minutos con `timer.unref()`, más lock transaccional por
  `(hotel_id, business_date)` — no es polling agresivo.

## Lo que NO alcancé a revisar

- **Costo real de voz/telefonía** (REQ-AGT-016, Telnyx/LiveKit/Deepgram/Cartesia): no
  hay ningún conector real en este snapshot (ADR-007, pendiente de credenciales) — no
  pude medir nada de la cadena STT→LLM→TTS porque no existe código que ejecutarla.
- **OCR autoalojado (identidad/CFDI/recibos)**: el pipeline de OCR (PaddleOCR-VL/GLM-OCR,
  LLM-005) tampoco existe en el código todavía (la imagen de identidad se descarta antes
  de llegar a ningún OCR, ver hallazgo positivo arriba) — no hay nada que medir.
- **Costo real de embeddings del RAG de FAQ/políticas** (LLM-007): no encontré ningún
  servicio de embeddings en el árbol; no puedo comparar contra el techo de USD 0.5/hotel/mes.
- **`apps/api/src/outbox/worker.ts` (`drainOutboxOnce`) fuera de un tick real de
  producción**: confirmé que `apps/api/src/server.ts` arranca `startNightAuditScheduler`
  pero NUNCA llama a `drainOutboxOnce` en un bucle — está declarado explícitamente como
  pendiente en `docs/PROGRESO.md` ("worker de outbox no corre automáticamente, sin cron
  todavía") y en `docs/runbooks/operacion.md:69-83` como ejecución manual/cron externo,
  así que no es un hallazgo nuevo oculto, pero tampoco pude verificar que exista un cron
  del sistema operativo real corriéndolo en ningún entorno — el crecimiento sin tope de
  `public.outbox`/`idempotency_key` sin ese proceso corriendo queda fuera de lo que este
  snapshot me permite comprobar (necesitaría acceso a la infraestructura desplegada, no
  solo al código).
- **Consultas repetidas de TanStack Query bajo navegación real del usuario** (staleTime
  por defecto 0 en todo `apps/web`, `App.tsx:27-34`): no llegué a instrumentar sesiones
  de navegación reales (Playwright + inspección de Network) para contar refetches
  duplicados entre páginas que comparten datos (p.ej. `hotelActivoId` en el header vs.
  en cada página) — solo revisé la configuración estática del `QueryClient`.
- **Costo por operación de `night_audit`/`cierre_mensual` una vez exista integración
  real de proveedor**: hoy `EnvProvider` siempre lanza `ProviderNotImplementedError`, así
  que no hay ninguna corrida real que medir end-to-end contra los techos de LLM-026
  (night audit ≤USD 0.10, cierre mensual ≤USD 1).
