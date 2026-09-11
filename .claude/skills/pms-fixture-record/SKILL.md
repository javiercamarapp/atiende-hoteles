---
name: pms-fixture-record
description: Graba y valida fixtures del contrato HTTP de Cloudbeds (PMS) contra el simulador local real del repo, para reemplazar fixtures hardcodeados en el adaptador con un registro versionado e inspeccionable. Úsala al agregar un endpoint nuevo al conector PMS, cuando el contrato de Cloudbeds cambie, o para regenerar/validar los fixtures existentes antes de un release.
---

# pms-fixture-record

CLI real (`scripts/skills/pms-fixture-record.ts`, REQ-AGT-021/BP-138) que graba y valida
fixtures de la API pública de Cloudbeds v1.3 contra `CloudbedsSimulator`
(`packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts`) -- el mismo servidor
HTTP local real que usa `contract.spec.ts` para probar `CloudbedsAdapter`. Nunca inventa
un payload a mano: cada fixture es una grabación real de request/response contra ese
simulador.

Los fixtures viven en `packages/mcp-servers/pms/fixtures/*.json`, uno por endpoint.

## Cuándo usarla

- Se agrega un endpoint nuevo a `CloudbedsSimulator`/`CloudbedsAdapter` -> correr
  `record` para capturar su fixture.
- El contrato documentado de Cloudbeds cambia (nuevo campo, nueva forma de respuesta)
  -> correr `record` para regenerar todos los fixtures y diffear contra los anteriores.
- Antes de confiar en los fixtures existentes (CI, o antes de un release) -> correr
  `validate`.
- Inspección humana rápida de qué hay grabado -> correr `list`.

## Subcomandos

```bash
# Regenera todos los fixtures levantando un CloudbedsSimulator real en un puerto
# efímero local (sin red externa, sin credenciales) y grabando 7 intercambios
# request/response (auth + los 6 endpoints de negocio del simulador).
node --experimental-strip-types scripts/skills/pms-fixture-record.ts record

# Valida la forma de los fixtures ya versionados en el repo (rápido, sin red,
# sin levantar el simulador) -- este es el comando que corre en CI.
node --experimental-strip-types scripts/skills/pms-fixture-record.ts validate

# Lista los fixtures presentes con su endpoint/status/fecha de grabación.
node --experimental-strip-types scripts/skills/pms-fixture-record.ts list
```

## Comando de verificación

Determinista, sin red, sin efectos secundarios -- el que corre
`scripts/checks/focus-y-skills-existen.ts` y CI:

```bash
node --experimental-strip-types scripts/skills/pms-fixture-record.ts validate
```
