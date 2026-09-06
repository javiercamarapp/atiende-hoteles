# Corrección auditoría-2 — lote A: seguridad multi-tenant + legal/privacidad

Corrector: Sonnet (Fable 5.1). Rama: `main`, sin push. Método: por hallazgo, reproducir
con sesión RLS real (nunca el cliente admin salvo cuando el propio hallazgo es "sesión
SQL directa saltándose la ruta") → prueba en rojo → arreglo mínimo → prueba en verde →
suite completa. Alcance recibido: `docs/auditoria-2/seguridad.md` (4 CRÍT, 2 ALTOS),
`docs/auditoria-2/legal.md` (3 CRÍT, 4 ALTOS, 2 MED, el CRÍT de "tarjeta en claro por
WhatsApp" es del lote B/`mensajeria.ts`), más los tres CRÍTICOS de
`docs/auditoria-2/datos.md` (D1-D3) que el coordinador añadió a este lote por coincidir
con la misma familia (D1=S1, D2=mismo patrón que el ALTO de `guest_id`) o requerir un
arreglo puramente de base (D3).

No se tocó ningún archivo de `packages/domain-hotel`, `packages/agent-core`,
`apps/api/src/routes/{folios,agentes,aprobaciones,mensajeria}.ts` ni
`apps/api/src/jobs/noShow.ts` (territorio del lote B). No se editó ningún informe de
`docs/auditoria-2/*.md`.

## Tabla hallazgo → estado

| Hallazgo | Rubro | Severidad | Estado | Commit(s) |
|---|---|---|---|---|
| S1/D1: `checkin_link.reservation_id` sin scope a hotel — secuestra el check-in online de otro hotel | seguridad + datos | CRÍTICO | **arreglado** | `b406e9b` (FK compuesta + `complete_checkin_public` usa hotel real), `e83b6ae` (defensa en la ruta + consentimiento) |
| D2: `reservation.guest_id` sin FK compuesta a `guest(hotel_id, id)` | datos (misma familia que ALTO de seguridad.md) | CRÍTICO (datos) / ALTO (seguridad) | **arreglado** | `dcf3056` |
| S2: `mark_charge_reversed()` no valida hotel del cargo | seguridad | CRÍTICO | **arreglado** | `de6a738` |
| S3: `night_audit_claim()`/`night_audit_finish()` filtran datos y permiten re-terminar una corrida ya completada | seguridad | CRÍTICO | **arreglado** | `5bd5315` |
| S4: `sat_filing_approval` forjable con doble membresía (multi-propiedad) | seguridad | CRÍTICO | **arreglado** | `b729ec5` |
| D3: folio `cerrado` admite `INSERT` de `charge` por carrera (10/10 reproducido) | datos | CRÍTICO | **arreglado** | `4c85fef` |
| ALTO: `reservation.guest_id` sin scope (ver D2, mismo arreglo) | seguridad | ALTO | **arreglado** (mismo commit que D2) | `dcf3056` |
| ALTO: `set_identity_checkout()` no valida hotel de la reserva | seguridad | ALTO | **arreglado** | `1cc08ab` |
| L1: purga de bóveda de identidad nunca corre en un proceso real | legal | CRÍTICO | **arreglado** | `747eae2` |
| L2: aviso de privacidad no declara transferencia de conversación a proveedor de IA | legal | CRÍTICO | **arreglado** | `b31115b` |
| L3-crítico: número de tarjeta en claro por WhatsApp | legal | CRÍTICO | **fuera de mi alcance** — pertenece al lote B (`apps/api/src/routes/mensajeria.ts`). No tocado. | — |
| ALTO: retención de identidad >30 días sin motivo ni auditoría | legal | ALTO | **arreglado** | `45e1e54` |
| ALTO: check-in online captura identidad sin registrar consentimiento | legal | ALTO | **arreglado** (esquema + ruta + página pública) | `e83b6ae`, `700d13b`, `b0fce62` |
| ALTO: sin infraestructura de opt-in/opt-out de marketing | legal | ALTO | **parcial / pendiente-coordinación** — tabla `consent` y `record_consent()` listas (`700d13b`); el bloqueo real tras "BAJA" vive en `packages/agent-core/src/tools/messagingTools.ts` y `apps/api/src/routes/mensajeria.ts`, ambos del lote B. No puedo cerrarlo yo sin tocar territorio ajeno. | `700d13b` (infraestructura) |
| ALTO: sin camino operable para ejercer derechos ARCO | legal | ALTO | **arreglado** | `700d13b` |
| MEDIO: disclosure de IA del primer turno no enlaza el aviso de privacidad | legal | MEDIO | **pendiente** — el texto `disclosureMessage` vive en `packages/agent-core/src/agents.ts`, fuera de mi alcance (territorio del lote B). Requiere coordinación. | — |
| MEDIO: runbook de brecha no fija el plazo legal de notificación | legal | MEDIO | **pendiente-decisión** — depende de asesoría legal externa que aún no se contrató, no es un bug de código; el propio runbook ya lo declara así. No se inventó un plazo. | — |
| (extra, cerrado en el mismo esfuerzo) retención configurable de `conversation`/`message` + purga programada | legal | ALTO (parte del mismo hallazgo de retención) | **arreglado**, con el número exacto de retención marcado `pendiente-decisión` | `fd95221` |

Prueba consolidada: `tests/adversarial/auditoria-2-lote-a-seguridad-legal.spec.ts`
(commit `8faf23e`, 17/17 verde). D3 se verificó explícitamente en rojo→verde: se
deshabilitó temporalmente `packages/db/migrations/0066_folio_cierre_race_lock.sql`
(moviendo el archivo fuera de `packages/db/migrations/`), se corrió la prueba y falló
como se esperaba (`expected true to be false`, es decir cargo+cierre ambos tuvieron
éxito), se restauró la migración y la prueba volvió a verde.

## Lo que quedó explícitamente fuera de mi alcance (territorio del otro lote)

- **Tarjeta en claro por WhatsApp** (`apps/api/src/routes/mensajeria.ts`): asignado al
  lote B en el despacho original, no lo toqué.
- **Opt-out de marketing / "BAJA" en WhatsApp** y **enlace del aviso en el disclosure de
  IA**: requieren tocar `packages/agent-core/src/agents.ts`,
  `packages/agent-core/src/tools/messagingTools.ts` y/o
  `apps/api/src/routes/mensajeria.ts` — todos explícitamente prohibidos para este
  corrector. La tabla `consent`/`record_consent()` (migración `0068`) ya está lista
  para que ese lote la use sin necesitar otra migración nueva.
- **Runbook de brecha (plazo legal)**: depende de asesoría legal externa, declarado
  correctamente como pendiente por el propio runbook; no es un hallazgo de código.

## Decisiones marcadas `pendiente-decisión` (requieren al fundador/equipo legal)

- `apps/api/src/routes/checkinOnline.ts:PRIVACY_NOTICE_VERSION` — string placeholder
  (`"2026-09-pendiente-confirmacion-legal"`), debe reemplazarse por el versionado real
  del aviso de privacidad publicado.
- `apps/api/src/jobs/purgeConversations.ts:DEFAULT_CONVERSATION_RETENTION_DAYS` (730
  días) — placeholder conservador, el número exacto es una decisión de negocio/legal.
- Texto final del aviso de privacidad (`apps/web/src/pages/Privacidad.tsx`): fecha de
  vigencia, domicilio del responsable, nombre del DPO — todo ya estaba marcado
  `pendiente-decisión` antes de este pase y sigue así (no se inventó nada).

## Suites ejecutadas (logs en `docs/logs/aud2-A-*.log`)

- `npm run lint` — 0 errores (1 warning preexistente en `tests/e2e/paridad-restaurantes-login.spec.ts`, no tocado por este lote).
- `npm run typecheck` — 0 errores (incluye `apps/api`; `apps/web` se validó aparte con `npm run typecheck`/`npm run build` dentro de `apps/web`, ya que el script raíz no lo cubre).
- `npm run test:unit` — 416 passed, 1 skipped.
- `npm run test:integration` — 164/164 passed.
- `npm run test:adversarial` — 130/130 passed (incluye la nueva suite de este lote).
- `npm run build` — OK (api + web).
- `npm run test:e2e` (Playwright, se tocó UI) — 42/44 en la corrida con 5 workers en
  paralelo; los 2 fallos (`axe-accesibilidad.spec.ts` timeout de `networkidle` en login,
  y `h6-housekeeping-mantenimiento-mensajeria.spec.ts` violación de "strict mode" por
  un texto ambiguo) **no tocan ningún archivo modificado por este lote** (no toqué
  `Login.tsx` ni `Mensajeria.tsx`) y **pasan limpio en aislamiento** con
  `--workers=1` (11/11) — confirmado como flake por contención de recursos entre
  workers paralelos, no una regresión de este pase.
