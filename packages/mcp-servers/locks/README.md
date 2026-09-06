# @atiende-hoteles/mcp-locks

`LockPort` -- emisión/revocación de llave digital vía capa de abstracción tipo Seam,
ADR-011. Cubre REQ-RES-017, REQ-REC-009 (P0, SEG), REQ-SEG-015 (P0), REQ-INT-008. Hito
**H11**. Ver `docs/ARQUITECTURA.md` ADR-011.

## Contrato (`src/port.ts`)

`issueKey`/`revokeKey` exigen **siempre**:

1. **Doble confirmación** de 2 actores distintos (`LockConfirmation.confirmedBy`
   diferente), ambas `approved: true` -- mismo criterio que la doble confirmación de
   dinero de `ApprovalQueue` en `packages/agent-core` (H6a). Incompleta →
   `DoubleConfirmationRequiredError`.
2. **Evidencia del PMS** (`PmsCheckInEvidence`): check-in pagado + identidad verificada.
   Incompleta → `PmsEvidenceMissingError`.
3. **Origen permitido**: `LockCommandOrigin` es `"guest_app" | "front_desk_staff"` --
   deliberadamente NO incluye `"voz"` ni `"regla_automatica_energia"`. Una llamada con
   esos orígenes ni siquiera compila (no son parte del tipo).

## Aislamiento estructural (GOB-044/REQ-SEG-015)

Este puerto es estructuralmente inalcanzable desde `@atiende-hoteles/mcp-energy`, desde
un motor de reglas automáticas o desde el canal de voz: ninguno de esos módulos importa
`@atiende-hoteles/mcp-locks`. Verificado por análisis estático en
`tests/unit/mcp-servers/architecture/lock-isolation.spec.ts` (recorre el árbol fuente de
`packages/mcp-servers/{energy,pms,whatsapp,payments,cfdi,shared}` y falla si aparece
cualquier referencia a este paquete o a `LockPort`/`issueKey`/`revokeKey`).

## Adaptador real (`src/adapters/seam-adapter.ts`)

**[PENDIENTE DE HARDWARE/CREDENCIALES]** -- requiere `SEAM_API_KEY` y
`SEAM_DEVICE_ID_PREFIX` (cuenta Seam + cerradura física). Las guardas de doble
confirmación y evidencia del PMS se verifican ANTES de comprobar disponibilidad de
hardware -- nunca se saltan por falta de cuenta Seam.

## Adaptador simulado (`src/adapters/simulated-lock-adapter.ts`)

`SimulatedLockAdapter` (comentario `// SIMULADO`, `simulated: true`). Aplica las mismas
guardas que el adaptador real; permite probar el flujo de check-in digital completo sin
hardware.

## Pruebas

`tests/unit/mcp-servers/locks/` cubre: rechazo con una sola confirmación, rechazo con 2
confirmaciones del mismo actor, rechazo sin evidencia de PMS (check-in no pagado /
identidad no verificada), emisión exitosa con las 3 condiciones cumplidas, y (junto con
`tests/unit/mcp-servers/architecture/`) que 0 líneas de código de energía/reglas
automáticas pueden alcanzar este puerto.

## Estado

**[PENDIENTE DE HARDWARE/CREDENCIALES]** -- REQ-RES-017/REC-009/SEG-015/INT-008
cubiertos con el adaptador simulado; adaptador real pendiente de cuenta Seam +
cerradura física piloto.
