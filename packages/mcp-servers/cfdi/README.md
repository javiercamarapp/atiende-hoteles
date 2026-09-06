# @atiende-hoteles/mcp-cfdi

`CfdiPort` para timbrado CFDI 4.0 de hospedaje vía PAC, con 2 PAC intercambiables
(H16-007). Cubre REQ-INT-005 (P0). Hito **H9**. Ver `docs/ARQUITECTURA.md` ADR-007.

Los nombres de PAC (`Finkok`, `SW`/`SW Sapien`) son ejemplos de proveedores mexicanos
reales de conocimiento público usados para dar forma realista al esqueleto; ni
`docs/REQUISITOS.md` ni H15 fijan un PAC específico -- la elección final de proveedor
contratado queda pendiente del fundador.

## Contrato (`src/port.ts`)

`timbrar` (idempotente por `folio`, lanza `CfdiFolioConflictError` si el mismo folio se
reenvía con datos distintos), `cancelar` (idempotente, catálogo `c_MotivoCancelacion`
del SAT), `consultarEstado`, `verifyAndNormalizeWebhook`. Incluye `ImpuestosLocales`
(ISH/DSA) en la entrada de timbrado.

Estado de dominio: `pendiente|timbrado|en_proceso_cancelacion|cancelado|rechazado`.

## Adaptadores reales (`src/adapters/{finkok,sw-sapien}-adapter.ts`)

**[PENDIENTE DE CREDENCIALES]**. `FinkokAdapter` requiere usuario/contraseña + CSD
(`FINKOK_USERNAME`, `FINKOK_PASSWORD`, `FINKOK_CSD_CERT_PATH`, `FINKOK_CSD_KEY_PATH`,
`FINKOK_CSD_PASSWORD`, `FINKOK_WEBHOOK_SECRET`). `SwSapienAdapter` requiere
`SW_API_TOKEN` + CSD equivalente + `SW_WEBHOOK_SECRET`. Sin CSD del hotel, ningún
método intenta timbrar contra el SAT real.

## Mitigación de doble-PAC (`src/adapters/dual-pac-cfdi-port.ts`)

`DualPacCfdiPort` compone un PAC primario y uno secundario: si el primario falla al
timbrar, conmuta al secundario **sin duplicar el timbrado** (idempotencia por `folio`
a nivel del wrapper, independiente de la idempotencia interna de cada PAC).

## Adaptadores simulados (`src/adapters/fake-pac-adapter.ts`)

`FakeFinkokAdapter`/`FakeSwSapienAdapter` (`simulated: true`), ambos instancias de
`FakeGenericPacAdapter` -- misma lógica de timbrado/cancelación/idempotencia. Exponen
`down` (booleano) para simular la caída de un PAC en la prueba de conmutación.

## Pruebas

`tests/unit/mcp-servers/cfdi/pac-doble.spec.ts` verifica: timbrado idempotente,
conflicto de folio, conmutación primario caído → secundario sin duplicar UUID, firma
HMAC de webhook (válida/inválida/replay).

## Estado

**[PENDIENTE DE CREDENCIALES]** -- REQ-INT-005 cubierto parcialmente: contrato,
mitigación de doble-PAC y adaptadores simulados verificados; adaptadores reales
pendientes de PAC contratado + CSD del hotel.
