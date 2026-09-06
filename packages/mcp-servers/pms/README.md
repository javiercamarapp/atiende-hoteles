# @atiende-hoteles/mcp-pms

Puerto de integración con el PMS del hotel (Cloudbeds primero, H15-001). Hito **H9**:
puerto + adaptador real esqueleto + adaptador simulado, sin credenciales reales. Ver
`docs/ARQUITECTURA.md` ADR-007 y `docs/referencia/03-investigacion-H12-H21.md` §5.

## Contrato (`src/port.ts`)

`PmsPort` cubre REQ-INT-001 (P0): reservas, tarifas, housekeeping, folio/cargos y perfil
de huésped, con webhooks de check-in/checkout normalizados al patrón
Ingress→RawEvent→Adapter.normalize (H15-016).

Mapeo de estados (provider-agnóstico: el resto del sistema solo conoce el enum de
dominio, igual que `reservation_status` de `packages/db` migración `0006`):

| Dominio | Cloudbeds nativo |
|---|---|
| `cotizada` | `not_confirmed` / `pending` |
| `confirmada` | `confirmed` |
| `en_estancia` | `checked_in` |
| `check_out` | `checked_out` |
| `cancelada` | `canceled` |
| `no_show` | `no_show` |
| `cerrada` | *(sin equivalente nativo -- solo interno, tras cierre de folio)* |

Housekeeping: `sucia|limpia|inspeccionada|fuera_de_servicio` ↔ `dirty|clean|inspected|out_of_order`.

## Adaptador real (`src/adapters/cloudbeds-adapter.ts`)

**[PENDIENTE DE CREDENCIALES]**. Requiere en entorno:

- `CLOUDBEDS_CLIENT_ID`, `CLOUDBEDS_CLIENT_SECRET`, `CLOUDBEDS_ACCESS_TOKEN` (OAuth2 del hotel).
- `CLOUDBEDS_WEBHOOK_SECRET` (firma HMAC de webhooks).

Sin estas variables, `status()` retorna `{ available: false, reason: "[PENDIENTE DE
CREDENCIALES] faltan: ..." }` y cada método lanza `PortUnavailableError` -- nunca se
fabrica una respuesta. El esqueleto sí implementa (sin ejecutarlo en este entorno):
rutas documentadas de la API v1.2 (`CLOUDBEDS_ROUTES`), auth Bearer, reintentos con
backoff exponencial + jitter ante `429`/`Retry-After` (`@atiende-hoteles/mcp-shared`),
idempotencia de `createCharge` por `idempotencyKey`, y verificación HMAC + guarda de
replay de webhooks (esta última función SÍ es ejecutable sin credenciales de API REST,
porque el secreto de webhook es independiente del OAuth).

## Adaptador simulado (`src/adapters/fake-cloudbeds-adapter.ts`)

`FakeCloudbedsAdapter` (`simulated: true` en `status()`). Fixtures realistas basadas en
la forma pública documentada de Cloudbeds (2 reservaciones con distintos estados,
tarifas por fecha). Implementa el contrato completo, incluida idempotencia real de
`createCharge` (segunda llamada con la misma clave no incrementa `chargeCallCount`) y
verificación HMAC/replay de webhooks con `FAKE_CLOUDBEDS_WEBHOOK_SECRET`.

## Pruebas

`tests/unit/mcp-servers/pms/` -- la misma suite de contrato corre contra
`FakeCloudbedsAdapter` siempre, y contra `CloudbedsAdapter` (real) solo si las 4
variables de entorno anteriores están presentes (se salta explícitamente, nunca falla
en falso, si no hay credenciales).

## Estado

**[PENDIENTE DE CREDENCIALES]** -- cubre REQ-INT-001 de forma parcial: contrato,
mapeo de estados y adaptador simulado verificados; adaptador real pendiente de
credenciales OAuth de un hotel piloto en Cloudbeds.
