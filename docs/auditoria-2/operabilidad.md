# Operabilidad y DX — auditoría 2

**Nota: 5/10** (sin ronda anterior — primera auditoría de este rubro). Razón: N/A,
primera ronda. La nota no es más alta porque los dos mecanismos que este rubro existe
para proteger — "un fallo del camino del dinero genera una alerta reconstruible" y "un
backup se puede restaurar de verdad" — tienen cada uno un defecto verificado en vivo
que produce una falsa sensación de seguridad (verificación que dice "OK" sobre datos
vacíos, un error de pool que no deja rastro). No es más baja porque `/health`/`/ready`
distinguen proceso vivo de base caída de verdad, el modo "sin credenciales" es honesto
(no inventa respuestas de agente), y la redacción de PII en logs, el outbox y
`check-migraciones` están bien probados y corrí varios de esos casos yo mismo.

El riesgo mayor hoy: **el runbook de backup/restauración puede confirmar "conteo
igual, verificación OK" sobre un respaldo con cero tablas**, y nada en el pipeline lo
detecta — un operador que siga el runbook al pie de la letra a las 3 a.m. se queda
creyendo que tiene un respaldo válido cuando no respaldó nada.

## Metodología

Prueba de máquina limpia real: copié el snapshot a `/tmp/audit2-clean/repo` (excluyendo
`node_modules`/`.pgdata`/`dist`, para que `npm install` no hiciera trampa con caché de
disco ya resuelto) y seguí únicamente los README disponibles, cronometrando. Ejecuté de
verdad `scripts/backup.sh`/`scripts/restore.sh`/`check:migraciones` contra
`embedded-postgres` real (con `pg_dump`/`psql`/`pg_restore` de Homebrew, `libpq`, no en
`PATH` por defecto en esta máquina) y corrí `tests/integration/api/observabilidad.spec.ts`,
`tests/unit/api/outbox-worker.spec.ts` y `tests/unit/api/logger-redact.spec.ts` contra el
código real (23+8+4 pruebas, todas verdes). No toqué Supabase, PSP, PAC ni WhatsApp real
(ADR-007, sin credenciales).

## Hallazgos

### [ALTO] `restore.sh` confirma "VERIFICACIÓN: conteo igual" sobre un backup vacío (0 tablas)
`scripts/restore.ts:22-32` (`contarFilasPorTabla`), `scripts/restore.ts:74-80` (cálculo de `ok`)

Escenario reproducido en vivo: en la copia de máquina limpia, arranqué `apps/api` con
`npm run dev --workspace=@atiende-hoteles/api` (el comando exacto de
`apps/api/README.md`), confirmé login real con datos sembrados (`gm@hotel-demo-centro.demo`,
2 hoteles, 336 filas), lo detuve, y corrí `./scripts/backup.sh /tmp/audit2-clean/backups`.
El backup "tuvo éxito": `Backup escrito en: ...dump`, `Tamaño: 1.0 KiB`. Pero
`pg_restore --list` sobre ese dump muestra `TOC Entries: 5` — sin una sola tabla:
`scripts/backup.ts:44` abrió un `embedded-postgres` **nuevo** contra
`DEFAULT_DB_DATA_DIR = "packages/db/.pgdata"` (`scripts/lib/pgClientBin.ts:15`, ruta
relativa resuelta contra el cwd del proceso, la raíz del repo) — un directorio que
nunca existió, porque la API que sí corrió minutos antes vía
`npm run dev --workspace=@atiende-hoteles/api` (el propio comando del README) escribió
sus datos en `apps/api/packages/db/.pgdata` (el mismo default relativo
`"packages/db/.pgdata"` de `apps/api/src/env.ts:63`, pero resuelto contra el cwd que
npm asigna a un workspace: `apps/api/`, no la raíz). `openEmbeddedPostgres` con un data
dir inexistente hace `initdb` de un cluster nuevo y vacío (`packages/db/src/engines.ts:174-177`)
y `backup.ts` lo respalda sin objetar.

Corrí después `./scripts/restore.sh` con ese mismo dump vacío:

```
Base restaurada: restore_check_1788712619093
Conteo de filas por tabla (origen vs. restaurado):
Total origen=0 restaurado=0
VERIFICACIÓN: conteo igual en todas las tablas.
```

`echo $?` → `0`. La causa exacta: `contarFilasPorTabla` (`restore.ts:22-32`) consulta
`information_schema.tables` del schema `public`; si el origen tiene 0 tablas, el `Map`
resultante está vacío, `porTabla` (`restore.ts:74`) queda `[]`, y
`porTabla.every(...)` sobre un arreglo vacío es `true` por vacuidad —
`ok = true` (`restore.ts:80`) sin que nada verifique que hubo AL MENOS una tabla o una
fila real (ej. `schema_migrations`).

Consecuencia: el runbook (`docs/runbooks/backups-restauracion.md`) documenta un caso
real con 23 tablas/336 filas y "VERIFICACIÓN: conteo igual" — un operador que confía en
esa misma frase de salida no tiene forma de distinguir, sin leer el archivo .dump a
mano con `pg_restore --list`, entre "mi backup de las reservas/folios de hoy es válido"
y "acabo de verificar que una base vacía es igual a otra base vacía". El camino del
dinero (folios, cargos, pagos, reservas) es precisamente lo que este runbook existe
para proteger.

Causa raíz probable: `DEFAULT_DB_DATA_DIR`/`env.dbDataDir` son rutas relativas sin
anclar a la raíz del repo, y ningún script de backup/restore valida un mínimo de
contenido (tablas/filas) antes de declarar éxito.

### [ALTO] El directorio de datos real de un `npm run dev` por workspace escapa el `.gitignore`
`.gitignore:13` (`packages/db/.pgdata/`), `apps/api/src/env.ts:63`

Consecuencia directa del mismo mecanismo de arriba, verificada por separado con un
repo git de prueba real (`git init` + `git status --porcelain --ignored` +
`git check-ignore -v`): la regla `packages/db/.pgdata/` en `.gitignore` (con una barra
intermedia) solo cubre esa ruta **relativa a la raíz del repo** — nunca
`apps/api/packages/db/.pgdata/`, que es donde queda el Postgres embebido real cuando
alguien arranca la API exactamente como dice `apps/api/README.md`
(`npm run dev --workspace=@atiende-hoteles/api`, ejecutado por npm con cwd en
`apps/api/`). Confirmado: `git check-ignore -v apps/api/packages/db/.pgdata/PG_VERSION`
no devuelve nada; `git check-ignore -v packages/db/.pgdata/PG_VERSION` sí (regla
`.gitignore:13`). Un `git add -A`/`git add .` posterior a un día normal de desarrollo
subiría binarios completos de Postgres (decenas de MB) con `scrypt` de las 16 cuentas
de staff sembradas y, en un entorno de piloto real que llegara a usar este mismo motor
local antes de migrar a Supabase, datos de huésped sin cifrar.

Consecuencia: fuga de secretos/PII vía commit accidental, sin ningún guardarraíl del
repo que la prevenga (no hay hook de pre-commit que rechace un `.pgdata` sin ignorar).

Causa raíz probable: la misma ruta relativa por defecto (`"packages/db/.pgdata"`)
compartida por `apps/api/src/env.ts` y `scripts/lib/pgClientBin.ts`, resuelta contra
cwd en vez de la raíz del repo, deja dos ubicaciones físicas posibles y el
`.gitignore` solo cubre una.

### [ALTO] Un error del pool de Postgres se descarta sin loguear nada
`packages/db/src/engines.ts:221-223`

```
pool.on("error", () => {
  /* silenciado: la siguiente pool.connect() simplemente abre una conexion nueva */
});
```

Escenario: `pool` es el `pg.Pool` que usa `withAppSession` (`packages/db/src/engines.ts:229-247`)
para **toda** request autenticada, incluidas `POST .../folios/:id/cargos`,
`.../pagos`, `.../reservas`. `node-pg` emite `error` en una conexión OCIOSA del pool
cuando el servidor la cierra de su lado (reinicio de Postgres, corte de red, un
`statement_timeout`/`idle_in_transaction_session_timeout` del lado del servidor, o —
en producción — el connection pooler de Supabase reciclando conexiones). El
`catch`/manejador aquí no llama a `logger` ni a `console.error`: no hay forma de
distinguir, después del hecho, entre "no pasó nada" y "el pool estuvo perdiendo
conexiones ociosas durante 20 minutos" — el único síntoma visible serían errores
sueltos y no correlacionados en rutas de dinero, sin ninguna línea que apunte a la
causa real. El comentario del propio código confirma que la decisión fue evitar
tumbar el proceso (correcto — un `EventEmitter` sin listener de `error` sí lo
tumbaría), pero se fue más lejos de lo necesario: se optó por no loguear nada en
absoluto, no solo por no relanzar.

Consecuencia: a las 3 a.m., un blip de red/Postgres que dispare varios eventos de
`pool.on("error")` no deja ningún rastro; el equipo de guardia solo ve síntomas
indirectos (latencia/errores 5xx en folios/reservas) sin la pista que señala al pool
como causa.

Causa raíz probable: el motor de bajo nivel (`packages/db`) no recibe un logger
inyectable, así que ni siquiera hay un canal disponible para reportar este evento sin
acoplar `packages/db` a `pino`/`apps/api`.

### [ALTO] La alerta del camino del dinero no tiene ningún destinatario — es una línea de log a stdout
`apps/api/src/lib/moneyAlert.ts:28-41`, `apps/api/src/app.ts:115-129`, `docs/ARQUITECTURA.md:234`, `docs/REQUISITOS.md:264`

`buildMoneyAlertLog` construye un objeto con `nivel: "alerta"` que
`deps.logger.error(...)` escribe como una línea JSON más del proceso Node (confirmado
corriendo `tests/integration/api/observabilidad.spec.ts` yo mismo: la línea existe y
tiene `nivel==="alerta"`, pero es eso — una línea de log — y nada más). No hay, en
ningún punto del código ni de `.env.example`, un
mecanismo de entrega (webhook, email, Slack, SMS, PagerDuty) ni una variable de
entorno que declare "a quién avisar". `docs/ARQUITECTURA.md:234` (ADR-008,
"Requisitos que cubre") lista **REQ-BO-034** ("alertas configurables con umbral y
**destinatario** por tipo") como cubierto por este ADR; pero `docs/REQUISITOS.md:264`
— la fuente de la verdad del estado de cada requisito — marca ese mismo REQ-BO-034
como **`pendiente`**. Ninguno de los dos documentos, ni `apps/api/README.md`
("Observabilidad"), dice explícitamente "hoy esto es solo una línea de log; falta
conectarlo a un canal real" — la sección de README lee como si la alerta fuera un
mecanismo completo. `docs/runbooks/incidentes.md §3.1` confirma el diseño real:
"Detección: Buscar en logs" — es decir, la detección depende de que alguien esté
activamente mirando o filtrando esos logs, no de que algo empuje una notificación.

Consecuencia: un cargo/pago/CFDI/reserva que falle con 5xx a las 3 a.m. no despierta a
nadie. La única forma de enterarse es que alguien, por otra vía, decida revisar los
logs del proceso — que en un `npm run dev`/proceso sin gestor persistente ni siquiera
sobreviven al cierre de la terminal.

Causa raíz probable: REQ-BO-034/H16-021 (umbral+destinatario configurable) nunca se
implementó; ADR-008 solo resolvió la parte de "generar la línea de log", no "entregarla
a alguien", y el propio inventario de requisitos ya lo admite como pendiente — el gap
real es que esa brecha no está declarada donde un operador la vería (README/runbook de
operación), a diferencia de cómo sí se declaran explícitamente otras integraciones
pendientes (WhatsApp/PSP/PAC, marcadas `[PENDIENTE DE CREDENCIALES]` en el mismo
README).

### [MEDIO] La alerta del camino del dinero no lleva `reservation_id`/`folio_id`/`charge_id`
`apps/api/src/lib/moneyAlert.ts:13-22`, confirmado por `tests/integration/api/observabilidad.spec.ts:194-213`

`MoneyAlertContext` solo tiene `requestId, route, method, status, orgId, hotelId,
userId, errorMessage`. `route` es el PATRÓN de ruta (`c.req.routePath`), nunca el path
crudo — por diseño explícito (comentario en `moneyAlert.ts:1-6`, para no acoplar este
archivo a las rutas de folios/reservas). El propio test que blinda este comportamiento
lo confirma línea por línea: `expect(alerta.route).toBe("/hoteles/:hotelId/folios/:folioId")`
— literal, con `:folioId` sin resolver, no el UUID real del folio que falló. El único
identificador real (el UUID de folio/reserva/cargo) vive en el `path` crudo de OTRA
línea de log (la línea "request" genérica), y el runbook (`docs/runbooks/incidentes.md
§3.2.1`) confirma que el procedimiento oficial es correlacionar a mano por
`request_id` entre dos líneas JSON con esquemas distintos.

Escenario: `POST /hoteles/<hotelId>/folios/<folioId>/cargos` falla con 500 (ej. una
constraint de Postgres, no un 4xx de validación). La alerta dice "algo falló en
`/hoteles/:hotelId/folios/:id/cargos` del hotel `<hotelId>`" — nunca "el folio
`<folioId>`". Si el pipeline de detección real termina siendo (como implica el propio
diseño del rubro) "reenviar solo las líneas `nivel:alerta` a un canal", ese canal nunca
va a mostrar qué folio/reserva/cargo específico falló.

Consecuencia: el gerente/on-call que recibe la alerta (una vez que exista un canal, ver
hallazgo anterior) tiene que ir a buscar manualmente la línea "request" con el mismo
`request_id` y parsear el path crudo para saber a qué huésped/folio corresponde el
error, antes de poder hacer cualquier cosa con `audit_log`.

Causa raíz probable: decisión de diseño de no acoplar `moneyAlert.ts` a los handlers de
folios/reservas (razonable para no duplicar lógica) que terminó sacrificando el campo
más útil de la alerta en el proceso.

### [MEDIO] Las métricas HTTP no llevan etiqueta de hotel
`apps/api/src/metrics.ts:56-78` (`recordRequest`), `apps/api/src/metrics.ts:80-82` (`incrementReservationsCreated`)

`recordRequest` etiqueta únicamente por `route`+`method`+`status`
(`labels = { route, method, status: String(status) }`, `metrics.ts:57`) —
`http_request_duration_ms`, `http_requests_total` y `http_errors_total` no tienen
`hotel`/`hotel_id` en ningún punto. `incrementReservationsCreated`
(`metrics.ts:80-82`) es un contador GLOBAL sin ninguna etiqueta: no hay forma de saber,
desde `/metrics`, cuántas reservas se crearon en el Hotel Demo Centro frente al Hotel
Demo Playa. El único contador que sí lleva etiqueta de hotel es
`agent_cost_usd_total` (`metrics.ts:88-91`, `incrementAgentCost`).

Consecuencia: un panel de Prometheus/Grafana externo no puede alertar "el hotel X dejó
de recibir reservas" ni "la tasa de error 5xx del hotel Y se disparó" sin cruzar contra
los logs estructurados (que sí llevan `hotel_id`) — se pierde exactamente la
granularidad por hotel que el negocio necesita (multi-hotel, multi-tenant) para no
tratar un problema de UN hotel como ruido agregado del sistema entero.

Causa raíz probable: `recordRequest`/`incrementReservationsCreated` se diseñaron antes
de necesitar el desglose por hotel, y nadie las revisó contra el eje central del
producto (varios hoteles por despliegue) al añadir `incrementAgentCost` con etiqueta
de hotel al lado.

### [BAJO] La máquina limpia no arranca solo con "el README" — hay que saber cuál
`README.md:1-8` (raíz), `apps/api/README.md:13-25`, `apps/web/README.md:9-31,32-42`

El `README.md` de la raíz del repo no tiene ninguna sección de "cómo correr" —
es únicamente el aviso de que la ubicación es provisional. Seguirlo literalmente dejaría a
cualquiera sin saber que existen `apps/api/README.md`/`apps/web/README.md`, ni que el
comando es `npm install` desde la raíz seguido de `npm run dev --workspace=@atiende-hoteles/api`
y `npm run dev --workspace apps/web` por separado, en dos terminales.

Una vez que se sabe eso (probado en vivo, tiempos reales sobre esta máquina): `npm
install` en la copia limpia ≈5s (caché local de npm), la API queda escuchando y con
`/ready` en verde ≈3s después de arrancar, y `npm run dev --workspace apps/web` sirve en
<1s. Total, sabiendo qué comandos correr: bajo un minuto. Pero el panel (`apps/web`)
NO se conecta al backend con los comandos del bloque "Cómo correr" solos: `VITE_API_URL`
queda `undefined` (no hay `.env`/`.env.local`, solo `.env.example`, y Vite nunca lee
`.env.example`), así que cada pantalla muestra el `EstadoError` honesto ("no tiene a
dónde conectarse") aunque la API esté sana. El paso que falta (`cp .env.example
.env.local`) sí está documentado, pero en la tabla de "Variables de entorno" más abajo,
no en el bloque de 4 comandos de "Cómo correr" — framed como opcional ("No" en la
columna "Requerida") cuando en la práctica es el único camino para ver datos reales sin
tocar código.

Consecuencia: fricción de DX baja pero real — alguien que ejecute literalmente los
comandos del quickstart de `apps/web/README.md` concluye "el panel no jala" en vez de
"me faltó un paso documentado dos secciones más abajo".

## Lo que revisé y está bien

- `apps/api/src/routes/health.ts:8-23` — `/health` nunca toca la BD (siempre 200 si el
  proceso vive); `/ready` sí, y devuelve 503 explícito si la conexión falla o si
  `schema_migrations` está vacía. Verificado en vivo (`curl` real contra el servidor
  levantado en la copia de máquina limpia: `{"status":"ok","migrationsApplied":41}`) y
  con `tests/integration/api/observabilidad.spec.ts` (`/ready` 503 con motor roto
  inyectado).
- `apps/api/src/logger.ts:12-36` — lista de campos sensibles razonablemente completa
  (`password, token, accessToken, refreshToken, jwt, email, telefono, phone, rfc, curp,
  numeroDocumento, passportNumber, pan, cvv`) con redacción en raíz y un nivel de
  anidamiento; `tests/unit/api/logger-redact.spec.ts` (4 pruebas) pasa contra un `pino`
  real, lo corrí yo mismo.
- `packages/agent-core/src/provider.ts:179-212` (`EnvProvider`) — exactamente el "modo
  sin credenciales honesto" que ADR-006 exige: sin `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY`
  lanza `ProviderUnavailableError` explícito; CON credenciales, lanza
  `ProviderNotImplementedError` (nunca fabrica una respuesta de agente). No hay ningún
  camino de código que "arranque bien" simulando una respuesta real sin credenciales.
- `apps/api/src/env.ts:32-55` — `JWT_SECRET`/`CORS_ALLOWED_ORIGINS` fallan el arranque
  con `throw` explícito en producción si faltan; sin comodín `*` permitido en CORS.
- `scripts/check-migraciones.ts` — análisis estático real (checksums SHA-256 +
  detección de `DROP COLUMN`/`DROP TABLE`/`TRUNCATE`/`ALTER COLUMN...TYPE` sin marcador
  `CONTRACT-APPROVED`), sin necesitar BD, corrido por mí mismo en la copia de máquina
  limpia: `check-migraciones: OK (41 migración(es) verificadas...)`. Wireado en
  `.github/workflows/ci.yml` como paso propio ANTES de `npm test`.
- `apps/api/src/outbox/worker.ts` — backoff exponencial con techo, dead-letter que
  nunca se borra, `handler_timeout` que no cuelga el resto del batch,
  `last_error` persistido siempre (fix de auditoria-1 retenido). Corrí
  `tests/unit/api/outbox-worker.spec.ts` (8/8 verdes) yo mismo.
- `apps/api/src/routes/mensajeria.ts:102-121` — el webhook de WhatsApp NO traga errores
  de base de datos en un 200 genérico: solo `WebhookSignatureError`→401 y
  `WebhookReplayError`→200 `{estado:"duplicado"}` están capturados explícitamente;
  cualquier otro error (ej. un `insert` que falle) se propaga a `app.onError` (5xx real).
- `apps/api/src/jobs/nightAuditScheduler.ts` + `apps/api/src/server.ts:38-42` — el
  planificador en proceso SÍ tiene `onError`/`onTick` conectados a `rootLogger` (no al
  vacío); lo confirmé en vivo: al arrancar la API en la copia de máquina limpia, el
  primer tick del night audit quedó como línea JSON con `results` completo (incluye
  `businessDate`/`ocupacion`/`conciliacionAB` por hotel).
- `docs/auditoria-1/pruebas.md:86` y `docs/REQUISITOS.md:375` — la ausencia del
  laboratorio edge en CI (REQ-QA-005/ADR-011) está declarada honestamente como
  "pendiente"/"no existe código de ese dominio todavía", no simulada ni dada por
  cumplida en ningún documento que revisé.
- `.github/workflows/ci.yml` — orden que falla rápido (lint → typecheck → test → build
  → e2e → npm-audit), con `check-migraciones` como paso explícito del job `test` antes
  de `npm test`.

## Lo que NO alcancé a revisar

- Backup/restauración contra Supabase real (producción, `docs/runbooks/backups-restauracion.md
  §3) — no hay credenciales ni proyecto Supabase disponibles; solo pude verificar la
  ruta local (`embedded-postgres`), que es donde encontré el hallazgo de arriba.
- El runbook de "brecha de seguridad" (`docs/runbooks/incidentes.md §1`) — lo leí pero
  no ejecuté un incidente simulado; el aislamiento/permisos que menciona es más del
  rubro de seguridad.
- El costo LLM por corrida (`agent_cost_usd_total`) contra un proveedor real — bloqueado
  por credenciales (ADR-007); solo confirmé que la métrica existe y se acumula en
  memoria por hotel+agente.
- El runbook de rotación de secretos (`docs/runbooks/operacion.md §6`) — no roté un
  `JWT_SECRET` real en vivo.
- Los adaptadores simulados de `packages/mcp-servers/energy`/`locks` más allá de
  confirmar que existen y que `REQ-QA-005` está declarado pendiente — el detalle de
  esos puertos es del rubro de arquitectura/integraciones, no de este.
- No corrí `npm test` completo (suite entera de unit+integración+adversarial); corrí
  específicamente los archivos relevantes a este rubro
  (`logger-redact`, `observabilidad`, `outbox-worker`) más las pruebas manuales de
  backup/restore/check-migraciones descritas arriba.
- El comportamiento de `pool.on("error")` bajo una caída real de Postgres a mitad de
  tráfico (solo leí el código y razoné el escenario; no forcé un `SIGKILL` al proceso
  de `embedded-postgres` con requests en vuelo para observarlo en vivo).
