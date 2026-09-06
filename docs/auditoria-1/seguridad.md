# Seguridad y aislamiento multi-tenant — auditoría 1

**Nota: 3/10** (sin ronda anterior — primera auditoría de código de este rubro; la
auditoría 0 fue solo de documentos, no de código). N/A movimiento.

El riesgo mayor hoy: `record_audit_log()` — la única vía de escritura del `audit_log`
append-only con hash encadenado — es `SECURITY DEFINER` y nunca valida que el
`tenant_id`/`hotel_id` que recibe correspondan al staff autenticado que la invoca;
cualquier cuenta de cualquier rol, en cualquier hotel, de cualquier organización cliente
de Atiende Hoteles puede insertar una fila arbitraria, correctamente encadenada por
hash, en la cadena de auditoría de **cualquier otra organización cliente** — la pieza
que se supone detecta manipulación queda ella misma manipulable desde fuera del tenant.

## Alcance verificado

Snapshot auditado: `.claude/worktrees/auditoria-1-snapshot`. En este hito el código
existente cubre solo `packages/db` (12 migraciones), `apps/api` (H2: auth, RLS por
sesión, roles, idempotencia, outbox, rate limit), `apps/web` (login, almacenamiento de
sesión) y `packages/agent-core` (aislamiento de contexto de prompt, tool registry,
redacción de PII). **No existen todavía** `packages/domain-hotel`, `packages/mcp-servers`
(WhatsApp/PMS/pasarela/CFDI/energía/cerraduras), ni una bóveda de identidad — por lo
tanto no hay webhooks que verificar, ni `EnergyPort`/`LockPort` que aislar, ni bóveda que
auditar; se declara así en vez de inventar hallazgos sobre código que no existe (ver "Lo
que NO alcancé").

Corrí `npm install --no-audit --no-fund` (ya estaba instalado), `npm audit` (1 alta en
`postcss`, dependencia transitiva de build de `apps/web`/Tailwind — es una herramienta de
build que procesa CSS del propio repo, no input de un atacante en runtime; se descarta
como insumo sin camino de explotación real en este producto, no como veredicto) y
reproduje dos escenarios de fuga contra PGlite (mismo motor que usan
`tests/unit/rls/*`) con scripts efímeros fuera del repo (`/tmp`), sin editar nada del
árbol.

## Hallazgos

### [CRÍTICO] `record_audit_log()` permite falsificar el audit_log de cualquier organización, no solo de otro hotel
`packages/db/migrations/0008_audit_log.sql:81-106` (función), `:105-106` (grants)

La función es `security definer` (corre con privilegios del dueño, no del rol
`authenticated` que la invoca) y su cuerpo inserta directamente con los parámetros
`_tenant_id`/`_hotel_id` que recibe, sin comparar contra `current_tenant_ids()` /
`current_hotel_ids()` del `auth.uid()` real de la sesión:

```sql
create or replace function public.record_audit_log(
  _tenant_id uuid, _hotel_id uuid, _action text, _entity_type text,
  _entity_id uuid, _payload jsonb default '{}'::jsonb
)
...
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (tenant_id, hotel_id, actor_user_id, action, entity_type, entity_id, payload)
  values (_tenant_id, _hotel_id, auth.uid(), _action, _entity_type, _entity_id, _payload)
  ...
```
y se otorga sin restricción de rol: `grant execute on function public.record_audit_log(...) to atiende_app, authenticated;`
(línea 106) — los 8 roles de `hotel_staff` (incluido `housekeeping`/`maintenance`, que no
tienen `can_access_money`) pueden ejecutarla.

Escenario reproducido (script efímero contra PGlite, mismo fixture que
`tests/unit/rls/*` — `seedDev()`): `housekeeping@hotel-demo-centro.demo` (rol
`housekeeping`, sin ninguna membresía en ninguna otra organización) inicia una sesión
real (`set local role authenticated` + `set_config('request.jwt.claim.sub', ...)`,
exactamente el mecanismo de `apps/api/src/middleware.ts:75-82`) y ejecuta:

```sql
select public.record_audit_log('<org-rival-uuid>', '<hotel-rival-uuid>',
  'payment.recorded', 'payment', gen_random_uuid(), '{"monto":999999}');
```

Resultado real obtenido: una fila queda insertada en `audit_log` con
`tenant_id = <org-rival-uuid>` (una organización sembrada como cliente completamente
ajeno, de la que este usuario no es staff en ninguna tabla), `hash` calculado
correctamente por el trigger `audit_log_set_hash()` encadenado a la cadena real de esa
organización (`prev_hash` correcto para esa cadena) — es indistinguible, por integridad
criptográfica, de un evento legítimo generado por el propio sistema de esa organización.

Consecuencia: cualquier organización cliente de Atiende Hoteles puede ver su cadena de
auditoría (la pieza que ADR-005/GOB-026 diseñan explícitamente para "detectar
manipulación") contaminada por cualquier otro cliente de la plataforma, sin que exista
relación alguna entre ambos. Un litigio o una disputa de cargo que dependa de "el
audit_log lo prueba" queda comprometido: la evidencia forense de la plataforma completa
es falsificable por cualquier cuenta de staff de cualquier hotel. Es además la propia
"tabla de la verdad" que REQ-TEN-001 exige proteger con RLS — aquí la protección se saltó
por completo vía `SECURITY DEFINER` sin validación interna equivalente.

Causa raíz probable: la función confía en que quien la llama (siempre `apps/api`, que sí
pasa `orgId`/`hotelId` ya verificados por `requireHotelMembership`) se porte bien, en vez
de validar ella misma `_tenant_id = any(current_tenant_ids())` — exactamente el patrón
que `docs/auditoria/RUBROS.md` describe como hallazgo ("RLS que se apoya en que la
aplicación se porte bien en vez de en la política misma").

Nota de verificación: los tests existentes (`tests/unit/audit-log.spec.ts`) llaman
siempre a `record_audit_log` vía `fixture.engine.admin` (cliente superusuario, sin RLS,
sin `auth.uid()` de un staff real) — ningún test ejercita esta función desde una sesión
`authenticated` con un `_tenant_id` ajeno. El hallazgo no está cubierto ni refutado por
la suite actual.

### [CRÍTICO] `outbox` e `idempotency_key` solo aíslan por organización, no por hotel: cualquier staff de un hotel lee y falsifica eventos de otro hotel de la misma org
`packages/db/migrations/0009_outbox_idempotency.sql:39-53` (RLS), `0010_grants_and_lockdown.sql:53-55` (grants)

Ambas tablas tienen columna `hotel_id` (`outbox.hotel_id`, nullable) pero sus políticas
RLS solo comparan `tenant_id = any(current_tenant_ids())` — nunca `hotel_id = any
(current_hotel_ids())` como sí hacen `room_type`/`reservation`/`folio`/`charge`/`payment`
en migraciones anteriores. El comentario del propio archivo (línea 4-6) afirma que estas
tablas están "restringidas a roles de gestión (owner/gm)", pero ninguna política
implementa ese filtro de rol — el `GRANT` es liso para todo `authenticated` y las
políticas no llaman a `has_hotel_role`/`can_access_money`.

Escenario reproducido (PGlite, mismo `seedDev()` con "Hotel Demo Centro" / "Hotel Demo
Playa" bajo la misma org): Hotel Demo Playa registra un pago de $7,000 MXN vía el flujo
real de `apps/api/src/routes/folios.ts:160-164` (que hace
`insert into outbox (...) values (..., 'payment.recorded', {paymentId, monto})`) y su
`idempotency_key` correspondiente guarda `{id, monto:7000, metodo:"tarjeta"}`.
`housekeeping@hotel-demo-centro.demo` (rol `housekeeping`, sin ninguna membresía en Hotel
Demo Playa) abre sesión real (mismo mecanismo de `apps/api`) y ejecuta:

```sql
select id, hotel_id, event_type, payload from public.outbox where tenant_id = $1; -- org compartido
select scope, key, response from public.idempotency_key where tenant_id = $1;
```

Resultado real obtenido: ambas consultas devuelven las filas de **Hotel Demo Playa**
(monto del pago, método, `paymentId`) pese a que el usuario no tiene rol alguno ahí. Además,
el mismo usuario pudo ejecutar con éxito:

```sql
insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
values ($1, '<hotel-playa-id>', 'payment', '<payment-id-de-playa>', 'payment.recorded', '{"inyectado":true}');
```

(el `INSERT` fue aceptado por RLS: `insertOk: true`). El worker de outbox
(`apps/api/src/outbox/worker.ts:44-57`) drena **todos** los tenants con el cliente admin
y despacha por `event_type` sin volver a validar pertenencia de hotel — un evento
inyectado así sería procesado como si viniera del hotel legítimo en cuanto exista un
handler registrado para ese `event_type` (WhatsApp, CFDI, PMS, según ADR-007 cuando se
construyan).

Consecuencia: fuga de datos financieros (montos, método de pago) entre hoteles de la
misma organización hacia roles sin ningún acceso a dinero (`housekeeping`/`maintenance`
quedan explícitamente excluidos de `folio`/`charge`/`payment` por diseño en
`0007_folio.sql`, pero no de `outbox`/`idempotency_key`, que contienen la misma
información en tránsito), y una vía de inyección de eventos falsos hacia el hotel ajeno
que el worker despachará a conectores externos reales en cuanto existan.

Causa raíz probable: `0009_outbox_idempotency.sql` se escribió acotando solo por
`tenant_id` (documentado como "operativas del backend", asumiendo que solo el propio
backend las toca) sin llevar el mismo patrón `tenant_id AND hotel_id` que sí se aplicó
consistentemente en `room_type`/`room`/`rate_plan`/`availability`/`guest`/`reservation`/
`folio`/`charge`/`payment` — la excepción no está declarada ni justificada en el propio
archivo, y el comentario que promete restricción por rol nunca se implementó.

Nota de verificación: ni `tests/unit/rls/tenant-isolation.spec.ts` ni
`tests/unit/rls/org-isolation.spec.ts` ni `tests/adversarial/aislamiento-tenant-hotel.spec.ts`
tocan `outbox` ni `idempotency_key` (verificado por lectura completa de los tres
archivos) — toda la cobertura de aislamiento por hotel existente se concentra en
`room_type`. El hallazgo no está cubierto por la suite actual.

### [MEDIO] CORS sin restricción de origen en toda la API
`apps/api/src/app.ts:23`

`app.use("*", cors());` usa la configuración por defecto de `hono/cors`, que fija
`Access-Control-Allow-Origin: *` para cualquier `Origin` entrante (verificado en
`node_modules/hono/dist/middleware/cors/index.js`: `origin: "*"` es el default cuando no
se pasa `options`). No hay ninguna lista de orígenes permitidos ni lectura de una
variable de entorno para acotarlo por ambiente.

Escenario: un sitio arbitrario `https://sitio-cualquiera.example` puede hacer
`fetch("https://api.atiende-hoteles.example/hoteles/.../resumen", {headers:
{authorization: "Bearer <token robado por otra vía>"}})` desde el navegador de una
víctima y leer la respuesta sin que el navegador bloquee la lectura por CORS (sí la
bloquearía con un `Access-Control-Allow-Origin` acotado al dominio real de
`apps/web`). El diseño Bearer-token (sin cookies) limita el impacto —no hay CSRF
"gratis" porque no hay credenciales ambientales que el navegador adjunte solo— pero
elimina una capa de defensa en profundidad que sí es barata de tener (restringir a los
orígenes conocidos de `apps/web` por variable de entorno).

Consecuencia: si en el futuro se agrega cualquier mecanismo de sesión basado en cookies
(o si el token quedara expuesto por otra vía, p. ej. un XSS), esta configuración no
opondría ninguna resistencia adicional.

Causa raíz probable: `cors()` se invocó sin opciones; falta acotar `origin` a partir de
una variable de entorno (mismo patrón que `env.ts` ya usa para otros valores
configurables).

### [BAJO] Límite de tasa en memoria de proceso, sin compartir entre instancias
`apps/api/src/lib/rateLimit.ts:13-36`

`MemoryRateLimitStore` guarda los contadores en un `Map` local del proceso Node. El
propio comentario del archivo (líneas 1-4) documenta esto como una elección deliberada
"por ahora", detrás de una interfaz pensada para sustituirse por Redis. Mientras la API
corra en más de una instancia (cualquier despliegue horizontal), cada instancia lleva su
propio contador: un atacante que reparta sus intentos de `/auth/login` entre N instancias
(vía round-robin del balanceador) multiplica por N el límite efectivo de intentos por
minuto antes de recibir 429, y un reinicio de proceso resetea el contador a cero.

Consecuencia: la protección de fuerza bruta contra `/auth/login` (`ipRateLimit`,
300/min/IP por defecto) es real solo en un despliegue de instancia única; en producción
con más de un proceso el límite efectivo es más alto de lo que `env.ts` declara.

Causa raíz probable: interfaz `RateLimitStore` ya preparada para un backend compartido,
pero la implementación real (Redis u otro) todavía no se construyó — deuda ya declarada
en el propio código, no oculta.

## Lo que revisé y está bien

- **`packages/db/migrations/0003_membership_and_rls_helpers.sql:34-93`**:
  `current_tenant_ids()`/`current_hotel_ids()`/`has_hotel_role()`/`is_hotel_staff()`
  derivan siempre de `hotel_staff` vía `auth.uid()` (el `sub` del JWT ya verificado
  criptográficamente), nunca de un valor que el cliente fije en la sesión — cierra
  exactamente el vector "claim de rol embebido obsoleto" que ADR-004 se propone evitar.
- **`apps/api/src/middleware.ts:90-126`**: `requireHotelMembership` es una segunda capa
  real (no cosmética): re-resuelve `orgId`/`hotelRole` con una consulta en vivo contra
  `hotel_staff` y **sobrescribe** cualquier claim del JWT (comentario explícito en línea
  118-120); confirmé además, por `grep`, que el binding `hotelIds` del JWT nunca se usa
  para autorizar nada (solo aparece en la línea de log de `app.ts:35`), y que
  `X-Hotel-Id` se valida contra el parámetro de ruta (`middleware.ts:98-101`) — no hay
  ningún camino donde un header no verificado decida el tenant/hotel de una escritura.
- **`packages/db/migrations/0006_reservation.sql` / `0007_folio.sql` / `0004_room_inventory.sql`**:
  RLS correctamente doble-acotada (`tenant_id` **y** `hotel_id`/`has_hotel_role`) en
  `room_type`, `room`, `rate_plan`, `availability`, `guest`, `reservation`, `folio`,
  `charge`, `payment` — verificado línea por línea, sin excepción en estas tablas.
  `folio`/`charge`/`payment` excluyen correctamente `housekeeping`/`maintenance` vía
  `can_access_money()`, verificado también en `apps/api/src/routes/folios.ts` (doble capa:
  `assertRole(c, MONEY_ROLES)` + RLS) y reproducido por `tests/adversarial/roles.spec.ts`.
- **`packages/db/migrations/0011_staff_auth_and_idempotency_hash.sql:13-16`**: el
  `GRANT` de columnas sobre `staff_user` excluye explícitamente `password_hash` del rol
  `authenticated` — ni siquiera la política "colega del mismo hotel" (`0003`) puede
  leerlo vía API; el login lee el hash con el cliente admin **antes** de que exista sesión
  (`auth.ts:77-80`), documentado como brecha equivalente al service-role de GoTrue.
- **`packages/db/src/password.ts`**: `scrypt` (N=16384, r=8, p=1, KEY_LENGTH=64) con
  salt aleatorio de 16 bytes por contraseña y comparación con `timingSafeEqual` —
  perfil de costo razonable, formato versionado, sin defectos de timing evidentes.
- **`apps/api/src/lib/jwt.ts`**: `alg` fijo a HS256 en la firma (no se lee de un header
  externo, cierra "algorithm confusion"/`alg: none`), `exp` corto (15 min access / 30
  días refresh) verificado por `jose`, tipos `access`/`refresh` distinguidos y validados
  explícitamente (un refresh token no sirve como access token y viceversa).
  `apps/api/src/env.ts:24-30`: `JWT_SECRET` sin valor por defecto silencioso en
  producción (`isProd` fuerza excepción si falta); el único default existe solo fuera de
  producción y está nombrado/documentado como inseguro.
- **`apps/api/src/routes/auth.ts:83-88`**: mensaje de error genérico idéntico exista o
  no el correo, sin filtrar cuál parte falló.
- **`apps/api/src/lib/errors.ts`**: ningún camino de error expone stack trace o mensaje
  crudo de Postgres al cliente; los `RAISE EXCEPTION` de dominio (`sin_disponibilidad`,
  `transicion_invalida`) y las violaciones de `row-level security` se traducen a
  mensajes genéricos con código HTTP correcto.
- **`packages/db/migrations/0008_audit_log.sql:61-77`**: `audit_log` bloquea
  `UPDATE`/`DELETE` con trigger además de no otorgar esos privilegios por `GRANT`
  (defensa en profundidad real, no solo documentada) — confirmado por
  `tests/unit/audit-log.spec.ts` intentando ambas mutaciones incluso con el cliente
  admin.
- **`packages/agent-core/src/context.ts:90-103`** (`buildContext`) y
  **`packages/agent-core/src/tool.ts:40-59,63-81`** (`assertNoIdentifierFields`,
  `defineTool`): el aislamiento de contexto de prompt (REQ-AGT-022) es fail-closed
  (lanza `CrossTenantContextError` en vez de filtrar en silencio) y el registro de tools
  rechaza en tiempo de definición cualquier campo `org_id`/`hotel_id`/`guest_id`/etc. en
  el esquema de entrada — el patrón "properties: {}" de ADR-006 está implementado como
  regla de tipo, no solo como convención.
- **`packages/agent-core/src/redact.ts`** y **`apps/api/src/logger.ts:6-17`**: PII
  (email/teléfono MX/INE/pasaporte/tarjeta) se redacta antes de trazar; verifiqué los
  dos únicos call-sites reales del logger (`app.ts:31-44`, `server.ts`) y ninguno
  registra cuerpo de request ni datos de huésped — solo IDs y metadatos.
  `pino({redact: {paths: [...]}})` cubre además `password`/`authorization`/`token` como
  defensa adicional.
- **`packages/agent-core/src/provider.ts:167-200`**: sin `ANTHROPIC_API_KEY`/
  `OPENROUTER_API_KEY`, `EnvProvider` lanza `ProviderUnavailableError` explícito; con
  credencial presente pero sin integración real construida, lanza
  `ProviderNotImplementedError` — nunca fabrica una respuesta simulada, tal como exige
  ADR-006.
- **`npm audit`**: 1 alta (`postcss`, cadena de build de Tailwind/Vite en `apps/web`,
  vulnerabilidad de *source map* en tiempo de build) — sin camino de explotación en
  runtime de este producto; se descarta como insumo, no como veredicto, según el mandato
  del rubro.

## Lo que NO alcancé a revisar

- **Webhooks (WhatsApp/PMS/pasarela) y verificación HMAC/dedupe (GOB-042)**: no
  auditables porque el código no existe todavía en este snapshot (no hay
  `packages/mcp-servers/*`); no se puede afirmar ni descartar nada sobre esto en esta
  ronda.
- **`EnergyPort`/`LockPort` (ADR-011) y su aislamiento estructural**: mismo caso —
  ningún archivo de energía/cerraduras existe aún; el análisis estático que exige
  `docs/ARQUITECTURA.md` (`scripts/checks/lockport-inalcanzable-desde-energia-y-voz.ts`)
  tampoco existe todavía.
- **Bóveda de identidad (GOB-044, `identity_ref`)**: `packages/db/migrations/0005_guest.sql`
  declara explícitamente que la bóveda está fuera de alcance de H1 (comentario propio de
  la migración); no hay servicio aislado que auditar todavía.
- **URLs firmadas de comprobante/factura (TTL)**: no existe ruta de generación de
  comprobantes/CFDI en este snapshot.
- **Concurrencia real contra `embedded-postgres`** (advisory locks, contención con dos
  conexiones de sistema operativo distintas): leí `packages/db/migrations/0004_room_inventory.sql`
  y los tests de integración/adversariales que la ejercitan
  (`tests/integration/availability-concurrency.spec.ts`,
  `tests/adversarial/reserva-concurrencia-y-limites.spec.ts`) pero no corrí la suite
  completa de integración/adversarial (requiere `embedded-postgres`, más costoso en este
  entorno) — el diseño se ve correcto por lectura y hay prueba nombrada, pero no
  reejecuté esa prueba yo mismo para confirmarla en vivo; ver rubro 2 (Backend y API)
  para el veredicto de concurrencia propiamente dicho, que no es el eje de este rubro.
  Tampoco reejecuté `npm run test`/`npx tsc --noEmit`/`npm run lint` completos sobre el
  árbol (mandato de esta ronda: auditar y reproducir escenarios puntuales, no correr la
  compuerta de cierre de ronda).
- **`apps/web`**: revisé almacenamiento de sesión (`localStorage`, sin XSS sink
  encontrado — sin `dangerouslySetInnerHTML` en todo `apps/web/src`) y ausencia de CSP,
  pero no encontré un vector de inyección concreto que combinar con ello; no lo reporto
  como hallazgo por no poder escribir el escenario "entra X → sale Y" que exige el
  protocolo, pero tampoco lo doy por cerrado — falta una revisión dedicada de XSS/CSP si
  el frontend crece.
- **Rotación/revocación de refresh tokens**: no existe lista de revocación; no lo reporto
  como hallazgo porque el frontend actual (`apps/web/src/lib/api.ts`) ni siquiera
  almacena el `refreshToken` que el backend emite — el mecanismo no está en uso real
  todavía, así que no hay escenario de explotación construible hoy.
