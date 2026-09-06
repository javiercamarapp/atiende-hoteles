# Runbook — Operación diaria

Ámbito: `apps/api` (Hono + Postgres). Entorno local de desarrollo/pruebas:
`embedded-postgres` (ADR-003). Producción: Supabase gestionado (ADR-003, D-001) —
las secciones marcadas **[Supabase]** describen el equivalente en producción; el resto
aplica igual en ambos porque el esquema/RLS es compatible.

## 1. Arrancar el sistema (local)

```bash
# 1. Migrar (crea packages/db/.pgdata si no existe, aplica migraciones pendientes)
npm run db:migrate
# 2. Sembrar datos de desarrollo (una sola vez, o tras `npm run db:reset`)
node packages/db/src/cli.ts seed
# 3. Levantar la API real (arranca su propio embedded-postgres persistente)
npm run dev --workspace=apps/api
# 4. Levantar el panel
npm run dev --workspace=apps/web
```

Variables de entorno: ver `.env.example` en `apps/api/` y `apps/web/`. Nunca commitear
`.env` (ya excluido en `.gitignore`, REQ-SEG-012).

## 2. Verificar que el sistema está sano

| Señal | Cómo verificarla | Verde esperado |
|---|---|---|
| Proceso vivo | `curl -s localhost:3001/health` | `{"status":"ok"}` |
| BD alcanzable + migraciones aplicadas | `curl -s localhost:3001/ready` | `{"status":"ok","migrationsApplied":N}` (N = número de archivos en `packages/db/migrations/`) |
| Métricas | `curl -s localhost:3001/metrics` | Texto Prometheus con `http_request_duration_ms_*`, `http_errors_total`, `outbox_pending`, `outbox_dead_letter`, `approvals_pending`, `reservations_created_total` |
| Logs estructurados | `LOG_PRETTY=1 npm run dev --workspace=apps/api` en una terminal, generar tráfico en otra | cada línea `request` trae `request_id`/`org_id`/`hotel_id`/`user_id`/`status`/`duration_ms`, sin PII cruda (ver §5) |

`/ready` responde `503` (nunca `200` disfrazado) si la BD no está disponible o si la
consulta a `schema_migrations` falla — ver `apps/api/src/routes/health.ts`.

**[Supabase]** en producción, el equivalente de "BD alcanzable" es el panel de
Supabase (Database → Health) o `SELECT 1` contra el `DATABASE_URL` de conexión directa
(no el pooler, para que cuente igual que `pg_isready`).

## 3. Leer las métricas (`/metrics`, formato Prometheus)

```
# HELP http_request_duration_ms Duración de la solicitud HTTP en milisegundos, por ruta/método/status.
http_request_duration_ms_bucket{route="/hoteles/:hotelId/reservas",method="POST",status="201",le="250"} 42
http_requests_total{route="...",method="...",status="..."} N
http_errors_total{route="...",method="..."} N        # solo 5xx
outbox_pending N                                       # eventos aún no entregados
outbox_dead_letter N                                   # agotaron reintentos (ver runbook de incidentes §2)
approvals_pending N                                    # 0 hasta que exista public.approval (H6b)
reservations_created_total N                            # contador de proceso, se reinicia con el proceso
```

Umbrales de alerta sugeridos (ajustar con datos reales de producción, hoy no hay
histórico):
- `outbox_dead_letter > 0` sostenido más de 15 min → runbook de incidentes §2.
- `http_errors_total` con `route` que contenga `/pagos`, `/cargos`, `/cfdi`,
  `/folios` o `/reservas` (camino del dinero) → buscar `nivel: "alerta"` en logs
  (ver §5) y ejecutar runbook de incidentes §1.
- `/ready` en `503` por más de 2 min → runbook de incidentes §3.

Protección opcional de `/metrics`: si se define `METRICS_TOKEN` en el entorno del
proceso, el endpoint exige la cabecera `X-Metrics-Token` con ese valor (401 si falta o
no coincide). Sin esa variable, `/metrics` queda abierto (como `/health`) — pensado
para exponerse solo dentro de la red privada del scraper de métricas, nunca a
Internet.

## 4. El worker de outbox

`apps/api/src/outbox/worker.ts` (`drainOutboxOnce`) drena eventos `pendiente` con
backoff exponencial (`min(baseMs * 2^attempts, maxDelayMs)`) y los marca `fallido`
(dead-letter, nunca se borran) tras `maxAttempts` (default 5) intentos. No hay todavía
un *scheduler* de proceso separado corriendo `drainOutboxOnce` en bucle (ver
`docs/BLOQUEOS.md`/ARQUITECTURA H8 — pendiente de un hito posterior que decida
cron/`setInterval` en el propio proceso de `apps/api` vs. un worker aparte); mientras
tanto, se puede drenar a mano:

auditoria-2/arquitectura [ALTO], corregido: este comando usaba
`--experimental-strip-types`, documentado en 9+ archivos como "el runtime real de
apps/api" cuando el flag real es `--experimental-transform-types` desde H5 (ver
`apps/api/package.json` "dev"/"start"). `import { drainOutboxOnce } from
"@atiende-hoteles/api"` evalúa el índice completo del paquete (`src/index.ts` reexporta
`createApp` de `app.ts`, que importa `@atiende-hoteles/mcp-payments`/`mcp-cfdi` — dos de
los paquetes con *parameter properties*, ver `scripts/check-runtime-flags.ts`) — con
`--experimental-strip-types` este comando literalmente falla con
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, reproducible tal cual en esta máquina.

```bash
node --experimental-transform-types -e '
import { openEmbeddedPostgres, applyMigrations } from "@atiende-hoteles/db";
import { drainOutboxOnce } from "@atiende-hoteles/api";
const engine = await openEmbeddedPostgres({ databaseDir: "packages/db/.pgdata", port: 54329, persistent: true });
await applyMigrations(engine.admin);
console.log(await drainOutboxOnce(engine.admin, { handlers: {} }));
await engine.stop();
'
```

(con `handlers: {}` todo evento pendiente queda `fallido` inmediatamente — solo para
inspeccionar el conteo; en producción los handlers reales se registran junto con las
integraciones de WhatsApp/PMS/pagos/CFDI cuando existan credenciales, ADR-007).

## 5. Logs: qué esperar y qué NUNCA debe aparecer

Formato: JSON por línea (pino), nunca texto libre en producción (`LOG_PRETTY` solo
para desarrollo interactivo). Campos estándar de cada línea `request`: `request_id`,
`org_id`, `hotel_id`, `user_id`, `method`, `path`, `status`, `duration_ms`.

Redacción automática (`apps/api/src/logger.ts`, `REDACT_PATHS`, REQ-AGT-006): cualquier
campo llamado `password`, `token`/`accessToken`/`refreshToken`/`jwt`, `email`,
`telefono`/`phone`, `rfc`, `curp`, `numeroDocumento`/`passportNumber`, `pan`, `cvv` (en
la raíz del objeto logueado o un nivel bajo otra llave) y `req.headers.authorization`
se reemplaza por `"[redactado]"` antes de escribirse. Prueba:
`tests/unit/api/logger-redact.spec.ts` (construye un pino real con un destino en
memoria y confirma que el valor sensible NUNCA aparece en el texto crudo de la línea).

Si un desarrollador necesita loguear un campo nuevo con PII, debe añadirlo a
`REDACT_PATHS` en el mismo cambio (no depender de acordarse después).

Alerta del camino del dinero: cualquier 5xx real en una ruta que contenga `/pagos`,
`/cargos`, `/cfdi`, `/folios` o `/reservas` (`apps/api/src/lib/moneyAlert.ts`,
`isMoneyPath`) emite una línea adicional con `"nivel": "alerta"`,
`"tipo": "error_camino_dinero"` y el contexto (`route`, `status`, `org_id`, `hotel_id`,
`user_id`, `request_id`). Un 4xx normal (validación, 404, 403) NO dispara esta alerta
— solo errores reales del sistema.

## 6. Rotación de secretos

Aplica a: `JWT_SECRET` (firma de tokens propios, `apps/api`), credenciales de BD
(`DB_PASSWORD`/`SUPABASE_DB_PASSWORD`), `METRICS_TOKEN`, y cualquier credencial de
integración que se añada después (WhatsApp Cloud, PSP, PAC de CFDI — ADR-007,
`REQ-SEG-013`).

**Cuándo rotar** (REQ-SEG-013, GOB-041):
1. Programado: cada 90 días como máximo para `JWT_SECRET` y credenciales de BD.
2. Inmediato (fuera de calendario): ante sospecha o confirmación de exposición
   (commit accidental, log con secreto sin redactar, empleado con acceso que sale de
   la empresa, alerta de un proveedor) — ver runbook de incidentes §1.

**Cómo rotar `JWT_SECRET` sin invalidar todas las sesiones de golpe** (no implementado
todavía como rotación dual-key; documentado como deuda explícita): hoy `verifyAccessToken`
(`apps/api/src/lib/jwt.ts`) valida contra un único secreto activo — rotarlo invalida
inmediatamente todos los access/refresh tokens vigentes (los usuarios deben volver a
iniciar sesión). Pasos:
1. Generar un secreto nuevo con suficiente entropía: `openssl rand -base64 48`.
2. Actualizar la variable de entorno (`JWT_SECRET`) en el/los proceso(s) de `apps/api`.
3. Reiniciar el proceso (sin *rolling restart* multi-instancia con secreto compartido,
   como documenta `auditoria-1/seguridad.md` [BAJO] sobre el rate limiter en memoria —
   mismo principio: un secreto por instancia sin coordinación central rompe sesiones a
   mitad de rotación en un despliegue horizontal).
4. Comunicar a usuarios activos que deben reiniciar sesión (mensaje de error genérico
   401 ya lo fuerza).
5. Registrar la rotación (fecha, motivo, quién la ejecutó) en un lugar auditable —
   hoy: entrada nueva en este runbook o en `docs/BLOQUEOS.md` si fue de emergencia;
   pendiente de bitácora de secretos dedicada cuando exista bóveda (REQ-SEG-010/014).

**Cómo rotar credenciales de BD:**
- Local (`embedded-postgres`): el usuario/clave (`postgres`/`postgres_dev_only_local`)
  están hardcodeados en `packages/db/src/cli.ts`/`packages/db/src/engines.ts` a
  propósito — es un cluster efímero/local de un solo desarrollador, nunca expuesto a
  la red, y está documentado como tal (nunca usar ese valor en producción).
- **[Supabase]**: rotar la contraseña del rol de BD desde el panel de Supabase
  (Database → Settings → Database password), actualizar `SUPABASE_DB_PASSWORD`/
  `DATABASE_URL` en el gestor de secretos del entorno de producción (Vault/KMS,
  REQ-SEG-013), y reiniciar `apps/api`. Nunca commitear la URL con la contraseña
  embebida.

**Nunca hacer** (REQ-SEG-012): commitear un secreto real a git (`.env` está en
`.gitignore`), pegarlo en un log/prompt/fixture, o reusar el mismo secreto entre
entornos (dev/staging/producción).

## 7. Contactos y escalamiento

Pendiente de definir formalmente (no hay todavía un equipo de guardia/on-call
documentado en este repo) — mientras tanto, cualquier alerta de `nivel: "alerta"` o
`/ready` en rojo sostenido la atiende quien esté operando el despliegue en curso; ver
runbook de incidentes para los pasos técnicos.
