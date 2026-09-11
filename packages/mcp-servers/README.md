# packages/mcp-servers

Puertos y adaptadores de integración externa de Atiende Hoteles. Hitos **H9**
(contratos de integración, ADR-007) y **H11** (puerto edge/IoT, ADR-011). Cada
subpaquete sigue la misma forma: `src/port.ts` (interfaz + esquemas Zod + errores
tipados + mapeo de estados), `src/adapters/*` (un adaptador real "esqueleto honesto"
por proveedor + un adaptador `Fake*`/`Simulated*` etiquetado), `src/index.ts`, y su
propio `README.md`.

Ningún adaptador real ejecuta una llamada de red/hardware en este entorno (sin
credenciales/hardware) -- todos se declaran `unavailable` con la razón exacta en vez de
fabricar una respuesta. Ver `docs/ARQUITECTURA.md` ADR-007/ADR-011.

## Tabla de integraciones

| Paquete | Puerto | Proveedor real (adaptador) | Adaptador simulado | Estado | REQ cubiertos |
|---|---|---|---|---|---|
| `mcp-pms` | `PmsPort` | Cloudbeds (`CloudbedsAdapter`) | `FakeCloudbedsAdapter` | **[PENDIENTE DE CREDENCIALES]** | REQ-INT-001 |
| `mcp-whatsapp` | `MessagingPort` | Meta WhatsApp Cloud API (`MetaWhatsappAdapter`) | `FakeWhatsappAdapter` | **[PENDIENTE DE CREDENCIALES]** | REQ-INT-003 |
| `mcp-payments` | `PaymentProviderPort` | Stripe (`StripeAdapter`) / Conekta (`ConektaAdapter`) | `FakeStripeAdapter` / `FakeConektaAdapter` | **[PENDIENTE DE CREDENCIALES]** | REQ-INT-002 |
| `mcp-cfdi` | `CfdiPort` | Finkok (`FinkokAdapter`) / SW Sapien (`SwSapienAdapter`), compuestos en `DualPacCfdiPort` | `FakeFinkokAdapter` / `FakeSwSapienAdapter` | **[PENDIENTE DE CREDENCIALES]** | REQ-INT-005 |
| `mcp-energy` | `EnergyPort` | Home Assistant + Shelly (`HomeAssistantAdapter`) | `SimulatedEnergyAdapter` | **[PENDIENTE DE HARDWARE]** | REQ-BO-027, REQ-BO-028, REQ-BO-029, REQ-INT-007 |
| `mcp-locks` | `LockPort` | Seam (`SeamAdapter`) | `SimulatedLockAdapter` | **[PENDIENTE DE HARDWARE/CREDENCIALES]** | REQ-RES-017, REQ-REC-009, REQ-SEG-015, REQ-INT-008 |
| `mcp-shared` | -- (utilidades, no es un puerto) | -- | -- | disponible | backoff, HMAC+replay, idempotencia, rate limiter, chequeo de credenciales |
| `mcp-hotel` | -- (servidor MCP propio, no un puerto hacia un tercero) | -- (no hay proveedor externo: expone este sistema hacia afuera) | -- | disponible | REQ-RES-021 |

Ninguna fila se declara `hecho`/"integración completa" -- el criterio "10 de 10" del
encargo se satisface aquí con la prueba de contrato contra el adaptador simulado (y,
donde aplica, el fixture documentado del proveedor), no con una ejecución real contra el
proveedor (ADR-007/ADR-011).

## REQ-INT-001..015 -- estado explícito

De acuerdo con `docs/ACEPTACION.md` fila H9: "todas quedan pendiente de credenciales en
esta fase salvo REQ-INT-012..015 que son verificables offline". Este hito NO construye
REQ-INT-012 (Ingress→RawEvent→Adapter.normalize→command bus formal, ya iniciado
parcialmente en `apps/api` H2), REQ-INT-004 (Google/Booking/TripAdvisor), REQ-INT-006
(voz/PBX), REQ-INT-009 (contabilidad) ni REQ-INT-013..015 -- quedan fuera del alcance
explícito de este worktree (solo `pms`, `whatsapp`, `payments`, `cfdi`, `energy`,
`locks`).

## Cómo se prueba cada integración sin credenciales

1. El adaptador `Fake*`/`Simulated*` implementa el puerto completo con fixtures
   realistas basados en la documentación pública del proveedor (citada en cada
   README de subpaquete).
2. La prueba de contrato (`tests/unit/mcp-servers/<paquete>/`) corre esa misma suite
   contra el fake siempre, y contra el adaptador real solo si
   `checkEnvCredentials(...)` confirma que las variables de entorno requeridas están
   presentes (se salta explícitamente en el reporte de resultados, nunca se finge
   verde).
3. Los webhooks se prueban con firma HMAC válida, inválida, y replay (mismo `event_id`
   dos veces) usando `@atiende-hoteles/mcp-shared`.
4. `energy`/`locks` añaden, sobre lo anterior: la guarda física local de HVAC (20-27°C),
   la prioridad de 2h del huésped, la exigencia de aprobación humana en toda acción
   física, la doble confirmación de llaves, y la prueba de arquitectura que confirma
   que `locks` es inalcanzable desde `energy` (o desde cualquier otro paquete de este
   árbol).

## Compuertas de calidad (H9)

Ver `docs/logs/h9-*.log`: `npm run lint` / `npm run typecheck` (por cada subpaquete +
raíz) / `npm run test:unit -- tests/unit/mcp-servers`.
