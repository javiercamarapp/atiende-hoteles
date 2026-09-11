# Trazabilidad — Atiende Hoteles

Fecha del pase: **2026-09-06**. Agente: Sonnet (trazabilidad). Rama: `main`. Fuentes leídas
completas: `docs/REQUISITOS.md` (276 REQ-* canónicos), `docs/ACEPTACION.md` (276 criterios de
aceptación con Estado/Evidencia por hito), `docs/cierre-p0/inventario.md` (inventario de P0
`ninguna`-dependencia pendientes de cierre, con razón por ID), `docs/PROGRESO.md` (bitácora de
hitos H1–H9/H11 y auditoría-1). Este documento no inventa evidencia: cada estado canónico
derivado se apoya en un archivo de prueba real y un log real bajo `docs/logs/`, ambos
confirmados en el árbol de trabajo el día de este pase (comandos en §5).

## 0. Resumen ejecutivo (sin maquillaje)

- **Estado canónico de los 276 REQ**: 18 `hecho` (6.5%), 20 `parcial` (7.2%, se sumó
  `REQ-AGT-006` el 2026-09-08 -- ver fila en §4: dos de tres cláusulas cerradas con
  evidencia real, PII redactada antes de persistir + 0 voiceprint/facial, la tercera
  -retención de audio- no aplica todavía porque no existe canal de audio en el repo), 87
  `pendiente-credenciales` (31.5%), 20 `pendiente-hardware` (7.2%), 3 `pendiente-decisión`
  (1.1%, ver nota §8: se sumó `REQ-AGT-013` el 2026-09-08, mismo criterio de
  `REQ-SEG-001`/`REQ-TEN-006` — evidencia textual explícita de decisión reservada al
  fundador, aquí LLM-023), 128 `pendiente` sin dependencia externa resuelta (46.4%).
- **P0 (128 requisitos)**: solo **15 hechos = 11.7%**. El resto: 18 parciales, 45
  pendientes de credenciales, 6 de hardware, 3 de decisión del fundador y 42 sin ninguna
  dependencia externa que lo explique (ver §2, columna "razón").
- **Población real de renglones marcados `hecho` en `ACEPTACION.md`**: **23**, no ≥40. La
  tarea pedía verificar por muestreo ≥40 REQ marcados `hecho`; como la población total es
  menor, se verificó el **100% de esa población** (23/23) en vez de una muestra parcial —
  ver §3. De esos 23, **5 (21.7%) se degradaron** al aplicar el criterio estricto de
  ACEPTACION.md §1.2 ("nada se marca completo con mock"): la evidencia citada existe y está
  en verde, pero el propio texto de la fila admite un remanente real pendiente de
  credenciales que ACEPTACION.md no debió etiquetar `hecho`. Los 18 restantes quedan
  confirmados `hecho` sin reservas.
- No se encontró ningún caso de evidencia inexistente ni de log en rojo citado como
  evidencia de cierre. El hallazgo dominante es de **etiquetado**, no de pruebas falsas.
- Un REQ (`REQ-AGT-003`) tiene evidencia verde real de H7 (`docs/logs/h7-test.log`) que
  `ACEPTACION.md` nunca reflejó — se documenta como desincronización, no se reclasifica
  unilateralmente (ver §3.4).

## 1. Metodología

1. Se extrajeron programáticamente las 276 filas de `docs/REQUISITOS.md` (Prioridad,
   Dependencia externa) y las 276 filas de `docs/ACEPTACION.md` (Depende de credenciales,
   Estado) — un script en Python parseó ambas tablas por `|` y las indexó por `REQ-ID`.
2. Se clasificó el **Estado canónico** de cada REQ con esta prioridad de reglas:
   - Si el Estado de ACEPTACION.md empieza en "hecho" (con o sin `**`) y no se autodescribe
     como parcial, y su remanente citado (si existe) es puramente estático/offline sin
     credencial pendiente → `hecho`.
   - Si el Estado empieza en "hecho" pero el propio texto dice `pendiente de credenciales`
     para una parte real del criterio (PAC/CFDI real, e.firma real, integración real con
     Meta) → se **degrada** a `pendiente-credenciales` (ver lista exacta en §3.2).
   - Si el Estado empieza en "parcial", o en "hecho"/"pendiente" pero se autodescribe como
     parcial en los primeros ~80 caracteres → `parcial`.
   - Si el Estado es "pendiente" liso: se usa la columna "Dependencia externa" de
     REQUISITOS.md para bucketizar en `pendiente-credenciales` (PMS, pasarela, WhatsApp/Meta,
     PAC/CFDI, telefonía/PBX, contabilidad, open banking, Google/Booking/TripAdvisor, nómina,
     credenciales fiscales, CMMS, datos externos) o `pendiente-hardware` (hardware/IoT,
     cerraduras, edge, CCTV, RFID); si la columna dice "ninguna", se revisa si el REQ está en
     el catálogo de decisiones reservadas al fundador (`REQ-SEG-001`, `REQ-TEN-006` →
     `pendiente-decisión`) o si `docs/cierre-p0/inventario.md` §2 documenta que la columna
     "ninguna" es engañosa (13 REQ de HUE/RES/SEG/CRM/BO/OBS con dependencia real oculta de
     canal WhatsApp/voz o del motor de ROI de H7 → `pendiente-credenciales`); en cualquier
     otro caso queda `pendiente` sin más clasificación.
3. **Muestreo/verificación de evidencia** (§3): para cada uno de los 23 renglones de
   ACEPTACION.md que arrancan en "hecho", se verificó (a) que el archivo de prueba o script
   citado existe en el árbol (`test -f` o `find`), (b) que el log citado existe en
   `docs/logs/`, y (c) que ese log contiene un resultado en verde (`Test Files N passed`,
   `exit 0`, `0 vulnerabilidades`, mensaje `OK` del script) que además nombra el archivo de
   prueba citado. Los dos scripts de revisión estática sin log fresco disponible
   (`no-ota-directa.ts`, `no-delete-events.ts`) se re-ejecutaron en vivo para esta
   verificación.
4. Copié el resultado (ruta de prueba + ruta de log, o razón de pendiente) a la columna
   Evidencia de cada fila de `docs/REQUISITOS.md`, y el Estado canónico a su columna Estado.

## 2. Conteos por módulo

| Módulo | hecho | parcial | pend.-cred. | pend.-hw | pend.-decisión | pendiente | Total |
|---|---|---|---|---|---|---|---|
| TEN | 1 | 2 | 0 | 0 | 1 | 2 | 6 |
| RES | 4 | 2 | 5 | 1 | 0 | 10 | 22 |
| HUE | 0 | 0 | 18 | 0 | 0 | 9 | 27 |
| REC | 3 | 2 | 5 | 2 | 0 | 2 | 14 |
| HK | 0 | 3 | 9 | 2 | 0 | 8 | 22 |
| AB | 0 | 0 | 4 | 2 | 0 | 8 | 14 |
| REV | 3 | 1 | 6 | 0 | 0 | 9 | 19 |
| CRM | 0 | 0 | 5 | 0 | 0 | 6 | 11 |
| BO | 1 | 1 | 15 | 7 | 0 | 13 | 37 |
| AGT | 0 | 1 | 2 | 0 | 0 | 19 | 22 |
| INT | 0 | 2 | 8 | 3 | 0 | 2 | 15 |
| SEG | 1 | 1 | 5 | 3 | 1 | 8 | 19 |
| OBS | 0 | 0 | 4 | 0 | 0 | 7 | 11 |
| UX | 0 | 2 | 1 | 0 | 0 | 3 | 6 |
| QA | 2 | 1 | 0 | 0 | 0 | 7 | 10 |
| GOB | 3 | 1 | 0 | 0 | 0 | 17 | 21 |
| **Total** | **18** | **19** | **87** | **20** | **2** | **130** | **276** |

Módulos sin ningún `hecho` todavía: HUE, HK, AB, CRM, AGT, INT, OBS, UX. Los tres módulos
completamente conversacionales/canal (HUE, AGT, OBS) dependen casi enteramente de credenciales
de WhatsApp/voz/Meta que este repo no tiene.

## 3. Conteos por prioridad

| Prioridad | hecho | parcial | pend.-cred. | pend.-hw | pend.-decisión | pendiente | Total | % hecho |
|---|---|---|---|---|---|---|---|---|
| P0 | 15 | 18 | 45 | 6 | 2 | 42 | 128 | **11.7%** |
| P1 | 1 | 1 | 29 | 4 | 0 | 50 | 85 | 1.2% |
| P2 | 2 | 1 | 12 | 5 | 0 | 33 | 53 | 3.8% |
| P3 | 0 | 0 | 1 | 5 | 0 | 4 | 10 | 0.0% |

**La cobertura real de P0 es baja: 11.7% hecho.** Incluyendo `parcial` (construcción real en
curso, no simulada) sube a 25.0% (32/128); el resto (75%) está bloqueado por credenciales
reales (45, 35.2%), sin bloqueo externo pero sin construir todavía (43, 33.6%), por hardware
(6) o por una decisión del fundador (2).

## 4. P0 no hechos: lista completa con razón y clasificación

Clasificación ∈ {Credenciales, Hardware, Decisión del usuario, Rediseño, Pendiente sin razón,
Parcial (construcción en curso)}. La razón de cada fila proviene de `docs/cierre-p0/inventario.md`
cuando ese REQ está ahí inventariado, o del propio texto de Estado/Evidencia de `ACEPTACION.md`
en caso contrario.

| REQ | Estado canónico | Clasificación | Razón (resumen) |
|---|---|---|---|
| REQ-AB-002 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS/POS |
| REQ-AB-004 | pendiente | Pendiente sin razón | El módulo de pedidos F&B (KDS/cocina) no existe todavía en el repo; no hay superficie sobre la cual aplicar la regla. |
| REQ-AGT-001 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 de docs/cierre-p0/inventario.md (pertenece al frente H7, que trabajaba en paralelo sobre agentes.ts/roi.ts); no se duplicó el trabajo desde ese worktree. |
| REQ-AGT-002 | parcial | Parcial (construcción en curso) | `tests/integration/agent-core/journey-checkin-incidencia.spec.ts`, `tests/adversarial/housekeeping-mantenimiento-mensajeria.spec.ts` · `docs/logs/h6b-test-integration-20260906-083619.log`. El spec prescrito `needs-approval-irreversible.spec.ts` no existe con ese nombre; cobertura equivalente en los archivos citados. |
| REQ-AGT-003 | pendiente | Pendiente sin razón (desincronización documental) | PROGRESO.md (H7, 2026-09-06) declara este REQ 'hecho' con evidencia verde real (`tests/unit/agent-core/roi-tools.spec.ts` 3/3, `tests/integration/api/agentes.spec.ts` 7/7, `docs/logs/h7-test.log`) — pero `docs/ACEPTACION.md` NUNCA fue actualizado para esta fila (su Estado sigue siendo literalmente "pendiente"). Se respeta ACEPTACION.md como fuente canónica de este documento y se reporta la desincronización en vez de reclasificar unilateralmente. |
| REQ-AGT-004 | hecho | Hecho (2026-09-11, posterior a este pase) | Reclasificado: `disable_parallel_tool_use` (`packages/agent-core/src/provider.ts`) se envía siempre en `true` desde `AgentRunner` (`runner.ts`) y además hay guardarraíl de refuerzo dentro del core (más de una tool `effect="money"` en la misma respuesta ⇒ ninguna se ejecuta). `tests/unit/agent-core/no-parallel-tool-money.spec.ts` (6/6). Ver `docs/REQUISITOS.md`/`docs/ACEPTACION.md`. Nota: conteo agregado del documento (§0/§1/"Distribución... 113 filas") no recalculado en este pase, mismo tratamiento que REQ-AB-004/REQ-HUE-014/REQ-HUE-021. |
| REQ-AGT-006 | parcial | Parcial (construcción en curso) | Reclasificado 2026-09-08: dos de tres cláusulas cerradas con evidencia real contra `embedded-postgres`. (1) PII redactada antes de persistir traza de observabilidad -- gap real encontrado (`agent_run.message` se insertaba SIN pasar por `redact()`, a diferencia del mismo texto en el evento `run_finished` de `audit_log`, que sí redactaba) y cerrado en `apps/api/src/lib/agentObservability.ts`; `tests/adversarial/pii-redaction-trazas.spec.ts` (3/3) prueba una corrida real con PII sintética y confirma 0 PII persistida. (2) 0 voiceprint/reconocimiento facial -- `scripts/checks/no-voiceprint-facial.ts`, exit 0. (3) Audio retenido 30-90 días -- NO aplica todavía: no existe canal de ingesta/almacenamiento de audio en el repo (voz/telefonía pendiente de credenciales, REQ-AGT-016/REQ-HUE-011), así que no hay tabla de audio sobre la cual fijar una ventana de retención. Evidencia: `docs/logs/REQ-AGT-006/`. |
| REQ-AGT-008 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-009 | parcial | Parcial (construcción en curso), reclasificado 2026-09-11 | `docs/ACEPTACION.md` ya declaraba "parcial" con evidencia extensa no reflejada aquí (desincronización, mismo patrón que REQ-AGT-003/022): `tests/adversarial/prompt-injection.spec.ts` (6/6 contra la API real + `embedded-postgres`) confirma que la capa de herramientas es la frontera de seguridad real para el canal WhatsApp (catálogo cerrado por agente, gate=shadow, aprobación humana, T2, loop-guard). Pendiente real: el canal de reseñas no existe en el repo (ni tabla, ni ruta, ni tool), esa mitad del criterio no puede verificarse aún. Nota: conteo agregado del documento (§0/§1/"Distribución... 113 filas") no recalculado en este pase. |
| REQ-AGT-013 | pendiente-decisión | Decisión del usuario | Reclasificado 2026-09-08 (lectura más profunda, exactamente el caso que §8 de este documento dejaba como trabajo futuro explícito): `docs/ARQUITECTURA.md` "Resolución de las 10 contradicciones" #10 cita LLM-023 exigiendo confirmación separada del fundador antes de desplegar un motor de OCR de origen chino (PaddleOCR-VL/GLM-OCR/Qwen3-Embedding) en producción, distinta de la aprobación de la Opción C — ver `docs/BLOQUEOS.md` D-008. El guardrail estático que sí es verificable sin esa decisión se construyó y quedó en verde: `scripts/checks/ocr-aislado-sin-internet.ts` (0 llamadas a LLM de canal/endpoint chino para OCR) + `tests/unit/agent-core/ocr-aislado-sin-internet.spec.ts` (9/9, adversarial) · `docs/logs/REQ-AGT-013/`. |
| REQ-AGT-015 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-016 | pendiente-credenciales | Credenciales | pendiente — depende de: telefonía/voz |
| REQ-AGT-018 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-019 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-022 | parcial | Parcial (construcción en curso), reclasificado 2026-09-11 | `packages/agent-core/src/context.ts` (`buildContext()`/`CrossTenantContextError`) cumple las 3 cláusulas del criterio literal de `docs/ACEPTACION.md` -- `tests/adversarial/aislamiento-contexto-prompt.spec.ts` (11/11, contra datos fiscales reales de 2 hoteles en PGlite; distinto del test H7 `agentes-aislamiento.spec.ts` citado en un pase anterior, que solo cubre aislamiento a nivel de ruta/rol, no de contexto/prompt). Pendiente real, no simulado: `buildContext()` tiene 0 sitios de invocación fuera de su propio módulo/prueba -- el `systemPrompt` real de `AgentRunner` es estático por agente (`agents.ts`), no se construye dinámicamente con fragmentos todavía, así que el guardarraíl no protege ninguna ruta real hoy. Mismo patrón que REQ-GOB-006/GOB-014 (máquina/función modelada y probada, sin aplicación automática en el flujo real). Nota: conteo agregado del documento (§0/§1/"Distribución... 113 filas") no recalculado en este pase. |
| REQ-BO-001 | pendiente-credenciales | Credenciales | Offline (PAC simulado): `tests/integration/contracts/cfdi/hospedaje.spec.ts` (7/7) · `docs/logs/h5-test-integration-20260906-082126.log`. PAC real (Finkok/SW Sapien) y CSD del hotel: pendiente de credenciales — degradado de "hecho" (ACEPTACION.md) a `pendiente-credenciales` por criterio estricto de este documento. |
| REQ-BO-002 | pendiente-credenciales | Credenciales | Offline (PAC simulado): `tests/integration/cfdi/idempotencia-timbrado.spec.ts` (4/4) · `docs/logs/h5-test-integration-20260906-082126.log`. PAC real: pendiente de credenciales — degradado de "hecho" a `pendiente-credenciales`. |
| REQ-BO-006 | pendiente-credenciales | Credenciales | Offline (a nivel de BD): `tests/adversarial/presentacion-sat-aprobacion.spec.ts` (4/4) · `docs/logs/h5-test-adversarial-20260906-082126.log`. Presentación real ante el SAT con e.firma real: pendiente — degradado de "hecho" a `pendiente-credenciales`. |
| REQ-BO-008 | parcial | Parcial (construcción en curso) | 2/2 tests de integración sobre `fiscal_obligation` · `docs/logs/h5-test-integration-20260906-082126.log`. Sin endpoint de API CRUD todavía (pendiente de back-office posterior, no de credenciales). |
| REQ-BO-010 | hecho | Hecho | P&L USALI 12ª ed. (resumen) por departamento (`packages/domain-hotel/src/pl/usaliPL.ts` + agregación real en `apps/api/src/domain/plUsali.ts`, migración `0115_pl_usali.sql` con `expense_entry`), forecast de 90 días (reutiliza `forecastExponentialSmoothing`), punto de equilibrio dinámico, owner's report y proyección de caja a 13 semanas, expuestos en `GET/POST /hoteles/:hotelId/back-office/{pl-usali,gastos}` · `tests/integration/bo/pl-usali.spec.ts` (4/4 contra embedded-postgres, dataset sintético de un periodo cerrado), `tests/unit/domain-hotel/usali-pl.spec.ts` (10/10) · `docs/logs/REQ-BO-010/`. |
| REQ-BO-011 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-BO-014 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-BO-024 | hecho | Hecho | Checador append-only (`attendance_log`, migración 0091, hash encadenado por empleado + cabeza de cadena FOR UPDATE, patrón de `audit_log`/0015) + horario programado (`staff_schedule`, migración 0090) + cruce/alerta de horas extra no autorizadas (`packages/domain-hotel/src/attendance.ts`) + API (`apps/api/src/routes/asistencia.ts`, incluida exportación CSV para STPS) · `tests/unit/domain-hotel/attendance.spec.ts` (17/17), `tests/unit/attendance-log.spec.ts` (13/13), `tests/adversarial/checador-inalterable.spec.ts` (10/10) · `docs/logs/REQ-BO-024/`. |
| REQ-BO-025 | pendiente | Pendiente sin razón | Regla de proceso sin superficie de producto propia todavía (no existe módulo de RR.HH.). |
| REQ-BO-027 | pendiente-hardware | Hardware | pendiente — depende de: hardware IoT |
| REQ-BO-028 | pendiente-hardware | Hardware | pendiente — depende de: hardware IoT |
| REQ-BO-029 | pendiente-hardware | Hardware | pendiente — depende de: hardware edge |
| REQ-BO-035 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-CRM-004 | pendiente-credenciales | Credenciales | pendiente — depende de: Google/TripAdvisor/Booking API |
| REQ-CRM-005 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-GOB-001 | pendiente | Pendiente sin razón | Regla de proceso de selección de tarea que el agente sigue por convención; sin superficie de código que la aplique mecánicamente todavía. |
| REQ-GOB-002 | pendiente | Pendiente sin razón | Regla de proceso (estudiar la tarea antes de implementar); no tiene artefacto de código propio verificable automáticamente. |
| REQ-GOB-005 | hecho | — | `scripts/checks/cierre-tarea-conventional-commits.ts` verifica el commit único en Conventional Commits por tarea cerrada (`tests/unit/gob/cierre-tarea-conventional-commits.spec.ts`, 46/46, incluye verificación end-to-end contra la tarea real REQ-GOB-004); la evidencia guardada y el criterio de aceptación verificable, las otras dos mitades de este criterio, ya los cubren REQ-OBS-010/REQ-GOB-003 respectivamente (ver ADR-012 para la decisión de mantener 3 scripts separados). Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006. |
| REQ-GOB-006 | pendiente | Pendiente sin razón | Regla de proceso (3 intentos→blocked); la máquina de estados que la modela (GOB-007) ya existe, pero la aplicación automática sobre backlog real de tareas no. |
| REQ-GOB-010 | parcial | Parcial (construcción en curso) | `tests/unit/migrations.spec.ts` · `docs/logs/h1-test-unit-20260906-045521.log`. Falta `scripts/checks/migraciones-expand-only.ts` (análisis estático de 0 `DROP` de columnas). |
| REQ-GOB-012 | pendiente | Pendiente sin razón | Catálogo de decisiones reservadas: formalizarlo como registro de aprobaciones verificable en código es un proyecto propio; hoy vive como prosa en REQUISITOS.md §3.16/BLOQUEOS.md. |
| REQ-GOB-013 | pendiente | Pendiente sin razón | `pms_mirror` todavía no existe como tabla (se crea con el primer conector PMS certificado real); la regla de 0 invocación directa a cerraduras ya se cumple de hecho pero sin check estático que lo congele. |
| REQ-GOB-016 | hecho | Hecho (2026-09-08, posterior a este pase) | Compartido con REQ-REV-018 (mismo criterio literal, ver esa fila) — `tests/adversarial/roi-sin-linea-base.spec.ts` (12/12) · `docs/logs/REQ-REV-018/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-GOB-019 | pendiente | Pendiente sin razón | Requiere importación de línea base de 12-24 meses de histórico durante onboarding; el flujo de onboarding con esa importación no está construido. |
| REQ-HK-001 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS + WhatsApp |
| REQ-HK-002 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-HK-011 | parcial | Parcial (construcción en curso) | `tests/integration/api/housekeeping-mantenimiento.spec.ts` · `docs/logs/h6b-test-integration-20260906-083619.log`. Clasificación por severidad declarada (no inferida) y recepción real por WhatsApp: pendiente de credenciales de Meta. |
| REQ-HK-013 | parcial | Parcial (construcción en curso) | `tests/adversarial/housekeeping-mantenimiento-mensajeria.spec.ts` · `docs/logs/h6b-test-adversarial-20260906-083619.log`. Reloj de SLA, escalado automático y despacho por WhatsApp con foto/ubicación: NO implementados en H6b. |
| REQ-HK-014 | parcial | Parcial (construcción en curso) | `tests/integration/api/housekeeping-mantenimiento.spec.ts`, `tests/integration/agent-core/journey-checkin-incidencia.spec.ts` · `docs/logs/h6b-test-integration-20260906-083619.log`. Foto de evidencia real, descuento de inventario/orden de compra automática y notificación al huésped: NO implementados. |
| REQ-HK-020 | pendiente-credenciales | Credenciales | pendiente — depende de: nómina |
| REQ-HK-021 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-HUE-001 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp/telefonía |
| REQ-HUE-002 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-HUE-004 | pendiente-credenciales | Credenciales | pendiente — depende de: PBX/telefonía |
| REQ-HUE-005 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-006 | parcial | Reclasificado (2026-09-08, posterior a este pase) | Igual que REQ-HUE-009/021: `docs/ACEPTACION.md` ya declaraba "Depende de credenciales: No" para este REQ exacto -- generalización engañosa haberlo agrupado con REQ-HUE-005/023. La mitad de WhatsApp se cerró de verdad con `FakeWhatsappAdapter` (webhook de `routes/mensajeria.ts` ahora invoca el disclosure engine de `agent-core` que existía pero estaba desconectado del flujo real). La mitad de voz sigue pendiente por falta real de código de telefonía/PBX en este repo (no solo credencial), ver `docs/REQUISITOS.md` fila REQ-HUE-006 para el detalle completo y evidencia. |
| REQ-HUE-009 | hecho | Hecho (2026-09-08, posterior a este pase) | Reclasificado: a diferencia de REQ-HUE-005/014/016 (que sí dependen de un canal real para tener sentido), el criterio de REQ-HUE-009 es una decisión determinista sobre un turno de voz ya transcrito, verificable sin telefonía real. `classifyVoiceGuardrailRefusal()` (`packages/domain-hotel/src/voiceGuardrails.ts`) se invoca en `POST /hoteles/:hotelId/agentes/:agente/ejecutar` (canal:"voz") ANTES de tocar presupuesto/proveedor. `tests/adversarial/voz-guardrails.spec.ts`: 12/12 formulaciones adversariales (3 por categoría) rechazadas, 0 aceptadas, contra la ruta real de la API + `embedded-postgres` real; `tests/unit/domain-hotel/voice-guardrails.spec.ts`: 11/11. Ver `docs/ACEPTACION.md` y `docs/logs/REQ-HUE-009/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-HUE-010 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela |
| REQ-HUE-013 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS |
| REQ-HUE-014 | hecho | Hecho (2026-09-08, posterior a este pase) | Reclasificado tras revisión (mismo criterio ya aplicado antes a REQ-BO-024/REQ-HUE-021): a diferencia de la generalización de `docs/cierre-p0/inventario.md` §2 (que agrupa TODOS los REQ-HUE-* mencionando WhatsApp/voz), `ACEPTACION.md` declara explícitamente "Depende de credenciales: No" para este REQ exacto y prescribe una prueba puramente de dominio/SLA sin canal — la conversión mensaje→ticket y la escalación automática son reglas de negocio 100% internas, verificables sin WhatsApp/voz. `guest_ticket`/`ticket_sla_policy` (migración 0098, RLS real) + clasificación determinística (`packages/domain-hotel/src/tickets/slaPolicy.ts`) + tool `crear_ticket_huesped` (agent-core) + `apps/api/src/routes/tickets.ts` + escalación con reloj inyectado (`apps/api/src/jobs/ticketEscalation.ts` + planificador `ticketEscalationScheduler.ts`, wired en `server.ts`, CLI `scripts/run-ticket-escalation-scheduler.ts`). Verificado con 9/9 en `tests/integration/tickets/sla-escalado.spec.ts` (contra `embedded-postgres` real) y 20/20 en `tests/unit/domain-hotel/ticket-sla-policy.spec.ts` · `docs/logs/REQ-HUE-014/`. Pendiente-credenciales real, fuera de este alcance: canal de ingreso por WhatsApp/voz y notificación/confirmación al huésped por ese canal (REQ-HUE-001/002). Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-QA-002/REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006/REQ-HUE-021. |
| REQ-HUE-015 | pendiente-credenciales | Credenciales | pendiente — depende de: telefonía/WhatsApp |
| REQ-HUE-016 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-017 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-020 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-HUE-021 | hecho | Hecho (2026-09-08, posterior a este pase) | `ACEPTACION.md` ya declaraba "Depende de credenciales: No" para esta fila (el criterio es gating de negocio, no integración con Meta): `hotel_messaging_config.marketing_templates` (migración 0099) + `isMarketingSendBlocked()`/`MarketingOptInRequiredError` (`packages/agent-core/src/tools/messagingTools.ts`, ejecutado dentro de `enviar_mensaje_whatsapp_plantilla.run()`) bloquean cualquier plantilla de marketing sin una fila `consent` (migración 0068) previa; `routes/mensajeria.ts` repite el chequeo antes de crear la solicitud de aprobación (rechazo inmediato, sin dejar una aprobación "viva" que nunca podría ejecutarse). Verificado en `tests/adversarial/opt-in-marketing.spec.ts` (7/7, adversarial contra la API real): transaccional sin opt-in, marketing sin opt-in (guest sin consent y teléfono sin guest) → 0 envíos, marketing con opt-in vigente → aprobación humana + envío, opt-out y opt-in de otro canal siguen bloqueados, y defensa en profundidad (aprobación ya "aprobada" sin opt-in) tampoco ejecuta. `docs/logs/REQ-HUE-021/`. Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-QA-002/REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006. |
| REQ-HUE-022 | pendiente | Pendiente sin razón | El check-in online de este pase (REQ-RES-016) no captura ningún dato biométrico (solo foto de documento para OCR, borrada tras extraer campos) — el requisito de "0 reconocimiento facial" ya se cumple estructuralmente — pero el consentimiento diferenciado explícito en UI para cualquier dato biométrico futuro queda pendiente de una pantalla dedicada. |
| REQ-HUE-023 | hecho | Hecho (2026-09-08, posterior a este pase) | Reclasificado (mismo criterio ya aplicado a REQ-HUE-009/REQ-HUE-021 en este mismo documento): a diferencia de la generalización de `docs/cierre-p0/inventario.md` §2, `ACEPTACION.md` prescribe una prueba adversarial de dominio/API sin canal real. 3 de las 4 categorías son clasificadores deterministas de texto ya recibido (`packages/domain-hotel/src/conversationalGuardrails.ts::classifyUnaccompaniedMinorEscalation`/`containsDiscriminatoryContent`, reutilizando `looksLikeRoomOrPresenceDisclosureRequest` de REQ-HUE-009 ahora también para el canal de texto en `apps/api/src/routes/agentes.ts`); "menor no acompañado" crea+escala de inmediato un `guest_ticket` real (`apps/api/src/jobs/ticketEscalation.ts::escalateGuestTicketNow`, nuevo) desde ese mismo endpoint y desde `POST /tickets`. La 4ª categoría (OTP en cambio de contacto) es un gate de negocio nuevo: `guest_contact_change_request` (migración 0113) + `packages/domain-hotel/src/guestContactChangeOtp.ts` + `apps/api/src/routes/huespedes.ts` (nuevas rutas `/contacto/solicitudes[/:id/confirmar]` y `/notas`) -- el OTP se envía SIEMPRE al `guest.phone` YA REGISTRADO (canal original, congelado al crear la solicitud), nunca al valor nuevo solicitado, verificado con `FakeWhatsappAdapter` (mismo criterio que REQ-HUE-021 con `consent`). Verificado con 15/15 en `tests/adversarial/guardrails-conversacionales.spec.ts` (contra la API real y `embedded-postgres` real) + 19/19 en `tests/unit/domain-hotel/conversational-guardrails.spec.ts` + `guest-contact-change-otp.spec.ts`. `docs/logs/REQ-HUE-023/`. Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-HUE-014/REQ-HUE-021. |
| REQ-INT-001 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS |
| REQ-INT-002 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela |
| REQ-INT-003 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp/Meta |
| REQ-INT-005 | pendiente-credenciales | Credenciales | pendiente — depende de: PAC/CFDI |
| REQ-INT-007 | pendiente-hardware | Hardware | pendiente — depende de: hardware IoT |
| REQ-INT-012 | parcial | Parcial (construcción en curso) | `tests/integration/api/reservas-y-folios.spec.ts`, `tests/unit/api/outbox-worker.spec.ts` (5/5) · `docs/logs/h2-test-integration-20260906-053949.log`. Ingress universal/`RawEvent`/`Adapter.normalize`/command bus formal: pendientes de una integración externa real (H9). |
| REQ-INT-014 | parcial | Parcial (construcción en curso) | `apps/api/src/lib/idempotency.ts` + `tests/integration/api/reservas-y-folios.spec.ts` · `docs/logs/h2-test-integration-20260906-053949.log`. HMAC + dedupe por `source.event_id`: pendiente de un webhook entrante real. |
| REQ-OBS-001 | pendiente-credenciales | Credenciales | pendiente — depende de: canales reales (WhatsApp/voz) + motor de ROI (H7); ver `docs/cierre-p0/inventario.md` §1.5 |
| REQ-OBS-002 | pendiente-credenciales | Credenciales | pendiente — depende de: canales reales (WhatsApp/voz) + motor de ROI (H7); ver `docs/cierre-p0/inventario.md` §1.5 |
| REQ-OBS-003 | pendiente | Pendiente sin razón | Requiere el backlog como máquina de estados con archivos reales por tarea (recién modelado en abstracto, GOB-007); migrar el proceso operativo del equipo es un cambio de flujo de trabajo, no solo código. |
| REQ-OBS-004 | pendiente | Pendiente sin razón | El checklist periódico de 11 puntos no puede correr hasta que el backlog operativo real exista como archivos. |
| REQ-OBS-005 | pendiente | Pendiente sin razón | Auditoría de release (sandbox real, replay 30 días, prueba de dinero/física, piloto firmado); requiere integraciones reales que aún no existen. |
| REQ-OBS-007 | hecho | Hecho (2026-09-08, posterior a este pase) | Reclasificado tras revisión (mismo criterio ya aplicado a REQ-HUE-014/REQ-HUE-021/REQ-SEG-007): a diferencia de la generalización de `docs/cierre-p0/inventario.md` §1.5 (que agrupa REQ-OBS-007 junto con REQ-OBS-001/002, ambos SÍ dependientes de canales reales para medir SLOs), `ACEPTACION.md` declara explícitamente "Depende de credenciales: No" para este REQ exacto y prescribe una prueba puramente de dominio (unit, sin canal ni motor de ROI real): la regla de honestidad de BP-171 ("recuperado/verificado" vs. "estimado", declarar en texto cuando lo verificado no cubre la cuota) es aritmética pura sobre `ROIEvent` YA agregados (mismo shape de entrada que ya expone `GET /roi`, `apps/api/src/routes/roi.ts`), verificable con datos sintéticos. `buildReporteMensualDueno()` (`packages/domain-hotel/src/pl/reporteMensualDueno.ts`) separa siempre `totalRecuperadoVerificadoUsd` de `totalEstimadoUsd` (sin duplicar el monto de un evento ya verificado como si también fuera estimado) y genera `declaracionHonestidad` -- texto literal, no solo un booleano -- que declara explícitamente cuando lo verificado es menor a la cuota de cobro, con la brecha exacta y aclarando que el estimado no cuenta para cubrirla. Verificado con 10/10 en `tests/unit/domain-hotel/reporte-mensual-honestidad.spec.ts`, incluyendo el caso central del criterio de aceptación (verificado < cuota → declarado en texto, no oculto). `docs/logs/REQ-OBS-007/`. Pendiente-credenciales real, fuera de este alcance: la AGREGACIÓN desde `roi_event`/facturación real de producción (requiere el motor de cobro por resultado de REQ-REV-018, aún pendiente, y canales reales para que haya eventos reales que agregar) -- ese consumidor de este módulo puro vive en la capa API, mismo patrón que `usaliPL.ts`/`apps/api/src/domain/plUsali.ts`, y no se construyó en este pase por estar fuera del criterio de aceptación exacto de REQ-OBS-007. Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-QA-002/REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006/REQ-HUE-021/REQ-HUE-014/REQ-SEG-007. |
| REQ-OBS-010 | pendiente | Pendiente sin razón | Ya se practica informalmente (`docs/logs/*.log` por tarea en este propio pase); falta el mecanismo que lo haga obligatorio/verificable automáticamente. |
| REQ-QA-001 | pendiente | Pendiente sin razón | Regla de proceso TDD (rojo→código→refactor); sin verificación automática del orden de commits todavía. |
| REQ-QA-002 | hecho | Hecho (2026-09-08, posterior a este pase) | `scripts/checks/no-tests-skip.ts` (revisión estática autocontenida, mismo patrón que `pms-mirror-solo-lectura.ts`): prohíbe sin excepción `xit(`/`xdescribe(`/`it.skip(`/`describe.skip(` en `tests/`, y prohíbe `test.skip(` (Playwright) fuera de `tests/e2e/` o dentro de `tests/e2e/` sin un segundo argumento no vacío que documente el motivo -- distingue así los 2 usos legítimos ya existentes (`test.skip(condición, "razón")` condicional por proyecto, `test.skip(true, motivoFallo)` con motivo nombrado) de un skip que esconde un caso que falla sin explicación, que sigue prohibido. Verificado con inyección viva sobre el CLI real (`xit(` fuera de e2e → detectado; `test.skip(true)` sin motivo dentro de e2e → detectado; limpiado sin residuos) además de `tests/unit/qa/no-tests-skip.spec.ts` (16/16 verdes, incluida una prueba que corre contra `tests/` real y confirma 0 violaciones con los 5 skips condicionales documentados existentes). Cableado a CI (`.github/workflows/ci.yml`, mismo patrón de fallo rápido antes de `npm test`, ADR-009). Fuera de alcance documentado: detectar una prueba "borrada" o "comentada" requiere diffing de historial/distinguir prosa, que el propio criterio no exige automatizar (su único método de verificación es el grep estático sobre el árbol actual) -- sigue siendo, como ya notaba `docs/cierre-p0/inventario.md`, una regla de proceso de revisión humana en esa mitad. Ver `docs/ACEPTACION.md` y `docs/logs/REQ-QA-002/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-QA-003 | hecho | Hecho (2026-09-08, posterior a este pase) | `tests/integration/contracts/gate-connector.spec.ts` (8/8) contra los 2 conectores externos reales (`FakeCloudbedsAdapter`/`FakeWhatsappAdapter` como fixture/sandbox): contrato (esquema Zod), idempotencia (webhook duplicado ⇒ replay rechazado antes de aplicarse, 1 solo efecto) y conflicto 409 (`PortConflictError` nuevo + `applyReservationUpdate` con concurrencia optimista real sobre `externalVersion` en `PmsPort`, solo PMS -- WhatsApp no tiene concepto de versión optimista, documentado explícitamente). El mecanismo de CI que faltaba (leer el `gate` declarado y disparar la suite) es `scripts/checks/gate-por-tarea.ts` (REQ-AGT-019, ya existente) ampliado: sus `requiredTests` para `connector-pms`/`connector-whatsapp` ahora exigen este archivo, verificado en vivo con una tarea sintética `gate: connector` (violación al renombrar el archivo, 0 violaciones restaurado). Cada uno de los 3 grupos de prueba se rompió por separado en la implementación real (replay guard, chequeo de conflicto, esquema `currency`) confirmando rojo específico antes de revertir. Ver `docs/ACEPTACION.md` y `docs/logs/REQ-QA-003/`. |
| REQ-QA-004 | hecho | Hecho (2026-09-08, posterior a este pase) | `tests/integration/gates/money.spec.ts` (7/7 contra `embedded-postgres` real, `npx vitest run tests/integration/gates/money.spec.ts` en verde) cubre las 3 propiedades del criterio: (1) `POST /hoteles/:id/quotes` con campos inyectados por un "LLM" (`totalAmount`/`llmSuggestedPrice`/descuento) devuelve exactamente el total del motor real (`loadNightlyRates`/`loadTaxConfig` → `computeQuote`/`applyTaxes`), nunca el valor inyectado — complementa (sin duplicar) la cobertura ya existente a nivel de función pura (`tests/unit/domain-hotel/pricing-source.spec.ts`) y de tool-calling (`tests/unit/agent-core/no-parallel-tool-money.spec.ts`, REQ-AGT-004); (2) `defineTool()` rechaza estructuralmente una tool `effect="money"` sin `needsApproval:true` (GOB-026), la única tool `money` del catálogo real (`autorizar_gasto_mantenimiento`) la declara, y de punta a punta vía HTTP + Postgres real se confirma que `POST /mantenimiento/:id/cerrar-con-costo` (acción irreversible) nunca ejecuta con una sola aprobación ni con el mismo actor repitiendo su confirmación (409), solo con dos actores/roles reales y distintos; (3) timbrado CFDI idempotente bajo la misma Idempotency-Key repetida y bajo dos solicitudes CONCURRENTES reales (`Promise.all`) — siempre 1 sola fila en `cfdi_emision`. Corre dentro de `npm test` (`test:integration`, ya requerido en CI) — sin paso dedicado nuevo en `.github/workflows/ci.yml`, mismo mecanismo de enforcement que la mayoría de los REQ-* de este documento. `npx eslint` limpio en el archivo nuevo. Evidencia: `docs/logs/REQ-QA-004/`. |
| REQ-QA-005 | pendiente | Pendiente sin razón | Mismo mecanismo de runner de gates que QA-003, para el gate `physical`; no construido (además requiere laboratorio edge). |
| REQ-QA-009 | parcial | Parcial (construcción en curso) | `tests/e2e/h4-reserva-real-desde-ui.spec.ts`, `tests/e2e/login-real-y-resumen.spec.ts`, `aislamiento-tenant-hotel.spec.ts`, `roles.spec.ts`, `tarifas-roles.spec.ts` (66 pruebas) · `docs/logs/h8-ci-test.log`. Recorrido esencial completo (housekeeping/mantenimiento + checkout con CFDI) aún no existe como un solo spec E2E. |
| REQ-REC-001 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela + PAC/CFDI |
| REQ-REC-003 | parcial | Parcial (construcción en curso) | `tests/adversarial/reserva-concurrencia-y-limites.spec.ts`, `tests/integration/api/reservas-y-folios.spec.ts`, `tests/integration/idempotency-ttl.spec.ts`, `tests/integration/idempotency-purga-por-lote.spec.ts` (3/3) · `docs/logs/p0-test-20260906-101549.log`. `PmsPort`/`MockPmsConnector` con `(connector, external_id, external_version)` sigue pendiente de credenciales PMS. |
| REQ-REC-006 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela + PMS |
| REQ-REC-009 | pendiente-hardware | Hardware | pendiente — depende de: cerraduras/hardware |
| REQ-REC-012 | parcial | Parcial (construcción en curso) | H5, 4/4 tests de autorización por rol/umbral (sin spec dedicado con el nombre prescrito) · `docs/logs/h5-test-adversarial-20260906-082126.log`. La doble verificación literal (apellido+habitación o token de check-in) NO se construyó. |
| REQ-RES-001 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-RES-002 | parcial | Parcial (construcción en curso) | `tests/unit/domain-hotel/pricing-source.spec.ts` (3/3) · `docs/logs/h4-test-unit-20260906-072138.log`. Contract test contra Cloudbeds real: pendiente de credenciales PMS. |
| REQ-RES-016 | parcial | Parcial (construcción en curso) | `tests/integration/checkin-online.spec.ts` (5/5), `tests/adversarial/checkin-chat-libre.spec.ts` (3/3) · `docs/logs/p0-test-20260906-101549.log`. WhatsApp Flow cifrado y pago/garantía: NO hecho, requieren credenciales reales. |
| REQ-REV-003 | pendiente | Pendiente sin razón | El motor de revenue dinámico (pricing automático) no está construido; este requisito gobierna su fase de arranque (shadow→autopilot), que aún no aplica. |
| REQ-REV-009 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS |
| REQ-REV-010 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS |
| REQ-REV-013 | parcial | Parcial (construcción en curso) | `tests/integration/revenue/night-audit.spec.ts` (5/5), `night-audit-scheduler.spec.ts` (8/8) · `docs/logs/h5-test-integration-20260906-082126.log`, `docs/logs/p0-test-20260906-101549.log`. Night audit independiente del PMS: hecho. Conciliación A&B/spa contra POS: reportada honestamente `sin_pos_configurado`, no implementada — degradado de "hecho" (ACEPTACION.md) a `parcial`. |
| REQ-REV-018 | hecho | Hecho (2026-09-08, posterior a este pase) | Captura de ROIEvent con supuesto versionado ya existía (H7/REQ-AGT-003). Esta pieza agrega `roi_baseline` (línea base por hotel+agente/módulo, firmable solo dentro de los 7 días —"semana 1"— siguientes a su activación, inmutable una vez firmada) y `cobro_resultado_activacion`, cuyo trigger de Postgres BLOQUEA la activación de un cobro por resultado sin línea base firmada para ese mismo hotel/agente (+ aprobación del fundador en profundidad, BP-150/GOB-052) — `packages/db/migrations/0120_roi_baseline_cobro_resultado.sql`, verificado contra `embedded-postgres` real: `tests/adversarial/roi-sin-linea-base.spec.ts` (12/12), `tests/unit/domain-hotel/roi-baseline.spec.ts` (10/10) · `docs/logs/REQ-REV-018/`. Fuera de este alcance (no confundir con "hecho"): el motor de FACTURACIÓN/cobro real (cálculo de la cuota periódica, generación del cargo) sobre una activación ya habilitada no está construido — esta pieza solo cubre el GATE de activación que exige el criterio literal. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-SEG-001 | pendiente-decisión (hook técnico hecho, 2026-09-09) | Decisión del usuario (parcial) | El texto legal definitivo del Aviso de Privacidad sigue reservado al fundador/equipo legal (REQ-GOB-012) -- no se redacta aquí. Lo que SÍ se cerró con código: el hook técnico de "accesible desde el primer contacto" que faltaba (hallazgo real de `docs/auditoria-2/legal.md`: el disclosure de IA del primer mensaje de WhatsApp no enlazaba al aviso). `buildDisclosureMessageConAvisoPrivacidad()` (`packages/agent-core/src/disclosure.ts`) + wiring en `routes/mensajeria.ts`/`routes/agentes.ts` (URL real vía `env.frontendUrl`). Web ya tenía el enlace (`Privacidad.tsx`/`Landing.tsx` etc., anterior a este pase). Voz: sin canal real (pendiente-hardware telefonía). Verificado: `tests/unit/agent-core/disclosure.spec.ts`, `tests/adversarial/disclosure-ia.spec.ts`, `tests/e2e/aviso-privacidad-primer-contacto.spec.ts`. `docs/logs/REQ-SEG-001/`. |
| REQ-SEG-009 | hecho (2026-09-09, posterior a este pase) | Cerrado en un pase posterior | Mismo criterio ya aplicado a REQ-SEG-007/011/013 (gating de negocio/mecanismo verificable sin credenciales reales de un proveedor concreto). Procedimiento humano documentado en `docs/runbooks/incidentes.md` §1, con mecanismo técnico real (§1.6): `POST/GET /hoteles/:hotelId/incidentes/brecha` (`apps/api/src/routes/incidentes.ts`) registra cada brecha de forma inmutable (`record_audit_log`), calcula `vulneracionSignificativa` con el criterio textual exacto del requisito, y notifica por webhook genérico configurable (`apps/api/src/lib/securityBreachAlert.ts`, mismo patrón que `moneyAlert.ts`/ADR-008); sin destino configurado lo declara al arrancar y en `GET /ready`. Probado de punta a punta contra un servidor HTTP real (no solo `fetch` sustituido): `tests/integration/api/incidentes.spec.ts` (5/5) + `tests/unit/api/security-breach-alert.spec.ts` (15/15) + bloque nuevo en `tests/integration/api/observabilidad.spec.ts`. Pendiente-credenciales fuera de este alcance: la URL/credencial REAL de producción (Slack/PagerDuty/correo) no está configurada (ADR-007) -- decisión operativa sin código pendiente; el canal final de notificación al huésped/INAI sigue siendo el proceso humano de runbook §1.4.1 (plazo/plantilla de asesoría legal, no inventados). `docs/logs/REQ-SEG-009/`. |
| REQ-SEG-003 | hecho | Hecho (2026-09-08, posterior a este pase) | `scripts/checks/no-biometria-facial.ts` (compartido con REQ-HUE-022: 0 reconocimiento facial en `apps/`+`packages/`) + `tests/adversarial/consentimiento-biometrico.spec.ts` (5/5 verdes, `embedded-postgres` real: un intento de colar dato biométrico en el body del check-in público, completado con éxito solo con el aviso general, persiste 0 filas en `guest`/`checkin_submission`/`identity_ref`/`consent`/`audit_log`; `consent_kind` solo admite `tratamiento_datos`/`marketing`). Ver `docs/ACEPTACION.md` y `docs/logs/REQ-SEG-003/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-SEG-005 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela |
| REQ-SEG-007 | hecho | Hecho (2026-09-08, posterior a este pase) | Reclasificado tras revisión (mismo criterio ya aplicado a REQ-HUE-021): `ACEPTACION.md` no exigía credenciales reales de Meta para este REQ, el criterio es gating de negocio verificable con `FakeWhatsappAdapter`. Opt-in (fecha/canal/texto): `isMarketingSendBlocked()`/`MarketingOptInRequiredError` (`packages/agent-core/src/tools/messagingTools.ts`) bloquean cualquier plantilla de marketing sin una fila `consent` (migración 0068) vigente — mismo mecanismo ya verificado por REQ-HUE-021. Opción de baja (la mitad de REQ-SEG-007 que REQ-HUE-021 no cubría): `hotel_messaging_config.marketing_template_bodies` (migración 0111) guarda el texto real de cada plantilla de marketing; `lintMarketingTemplateBody()` (`packages/domain-hotel/src/marketingTemplateLinter.ts`) exige y valida en `PATCH .../mensajeria/config` (apps/api) que ese texto incluya una opción de baja reconocible ANTES de poder clasificarse como marketing (400 si no, config nunca queda "a medias"); el envío real (`getMarketingTemplateBody`, agent-core) persiste ese mismo texto ya verificado como `message.body`, así el propio dato persistido demuestra la opción de baja. Verificado en `tests/adversarial/opt-in-marketing.spec.ts` (11/11, ahora también cubre el linter — casos (f)) y `tests/unit/domain-hotel/marketing-template-linter.spec.ts` (7/7, unidad pura del linter). `docs/logs/REQ-SEG-007/`. Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-QA-002/REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006/REQ-HUE-021/REQ-HUE-014. |
| REQ-SEG-010 | pendiente-credenciales | Credenciales | pendiente — depende de: credenciales fiscales |
| REQ-SEG-012 | pendiente | Pendiente sin razón | Requiere agregar un scanner de secretos (gitleaks) al pipeline de CI; no se tocó en el pase de cierre P0 por enfoque en app/dominio. |
| REQ-SEG-013 | parcial | Parcial (2026-09-08, posterior a este pase) | Variables de entorno: ya resuelto antes de este pase (`apps/api/src/env.ts`/`identityEncryption.ts`, fail-closed sin default silencioso en producción), ahora verificado estáticamente por `scripts/checks/env-sin-secretos-reales.ts` (0 `.env` real trackeado, 0 valor real en `.env.example`, 0 secreto hardcodeado en `apps/**/src`/`packages/**/src`; wired en `.github/workflows/ci.yml`). Vault/KMS en producción: `apps/api/src/lib/secretsProvider.ts` agrega un provider real (protocolo HTTP genuino de HashiCorp Vault KV v2), opt-in vía `SECRETS_BACKEND=vault`, fail-closed si se activa sin configuración completa, wired en `apps/api/src/server.ts` antes de `loadEnv()`. Verificado con 13/13 en `tests/unit/api/secrets-provider.spec.ts` (protocolo contra `fetch` sustituido) · `docs/logs/REQ-SEG-013/`. Pendiente-credenciales/infraestructura real, fuera de este alcance: `VaultSecretsProvider` NUNCA se ha probado contra una instancia real de Vault/KMS (no existe ninguna desplegada ni credenciales de ese servicio en este entorno) — no confundir "el protocolo existe y está probado contra un doble" con "Vault/KMS está integrado en producción". Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-BO-024/REQ-QA-002/REQ-AGT-004/REQ-SEG-012/REQ-OBS-010/REQ-GOB-006/REQ-HUE-021/REQ-HUE-014/REQ-SEG-007/REQ-OBS-007. |
| REQ-SEG-014 | parcial | Parcial (construcción en curso) | `tests/adversarial/boveda-identidad.spec.ts` · `docs/logs/p0-test-20260906-101549.log`. "Doble control" pleno (2 personas aprobando la misma lectura): NO implementado. |
| REQ-SEG-015 | pendiente-hardware | Hardware | pendiente — depende de: hardware edge/cerraduras |
| REQ-SEG-016 | parcial (2026-09-09, posterior a este pase) | Parcial (construcción en curso) | Exportable sin imágenes: hecho -- `GET /hoteles/:hotelId/huespedes/registro-migratorio?desde=&hasta=` (`apps/api/src/routes/huespedes.ts`) une `guest`+`identity_ref` (cubre check-in en línea y registro manual por MRZ); "sin imágenes" es garantía ESTRUCTURAL (ninguna tabla del esquema tiene columna de imagen). `tests/adversarial/registro-huespedes-migratorio.spec.ts` (5/5). Retención por plaza: NO implementada -- sin campo de jurisdicción en el esquema (decisión legal/negocio reservada, misma clase que REQ-SEG-001/REQ-GOB-012, no inventada aquí) y sin fuente de datos real para audio/IoT/CCTV (pendiente-hardware, REQ-SEG-006/REQ-SEG-015). CFDI (5 años) cumple por diseño (ningún job de este repo lo purga). Hallazgo señalado, no resuelto unilateralmente: tensión real con REQ-SEG-004 (la purga de `identity_vault` a 30 días post-checkout hoy también borra en cascada el `identity_ref` asociado, `tests/adversarial/boveda-identidad.spec.ts`) -- decidir si el registro migratorio debe sobrevivir esa purga es una decisión de producto/legal propia, ver `docs/BLOQUEOS.md`. `docs/logs/REQ-SEG-016/`. |
| REQ-TEN-001 | parcial | Parcial (construcción en curso) | `tests/unit/rls/org-isolation.spec.ts`, `tests/unit/rls/tenant-isolation.spec.ts`, `tests/adversarial/auditoria-1-bd-criticos.spec.ts` (9/9) · `docs/logs/h1-test-unit-20260906-045521.log`, `docs/logs/aud1-bd-test-20260906-075050.log`. Falta repetir la matriz de aislamiento por cada tabla de tenant nueva. |
| REQ-TEN-002 | hecho | Hecho (2026-09-11, posterior a este pase) | Reclasificado: el esquema estructural (`packages/db/migrations/0002_org_location_hotel.sql`, `hotel` como extensión 1:1 de `location(kind='hotel')` bajo `org`) ya existía; lo que faltaba era la verificación automatizada exigida por `docs/ACEPTACION.md`, ya construida: `tests/integration/schema/location.spec.ts` (7/7 contra `embedded-postgres` real) + `scripts/checks/schema-location.ts` (exit 0). Ver `docs/REQUISITOS.md`/`docs/ACEPTACION.md`. Nota: conteo agregado del documento (§0/§1/"Distribución... 113 filas") no recalculado en este pase, mismo tratamiento que REQ-AB-004/REQ-HUE-014/REQ-HUE-021. |
| REQ-TEN-003 | parcial | Parcial (construcción en curso) | `tests/adversarial/roles.spec.ts` (20/20) · `docs/logs/h2-test-adversarial-20260906-053949.log`. Falta `tests/e2e/staff-pwa.spec.ts` (H6). |
| REQ-TEN-006 | pendiente-decisión | Decisión del usuario | Depende de que exista contenido de disclosure real aprobado (texto legal, REQ-GOB-012) antes de tener sentido centralizarlo; construir el motor vacío sería simular el requisito. |
| REQ-UX-001 | hecho (posterior a este pase) | Cerrado en un pase posterior | Paridad visual verificada en vivo, mismo Chrome (`chromium.launch({channel:'chrome', args:['--force-prefers-reduced-motion']})`) para las dos apps: logo (`AtiendeWordmark`) con diff de píxeles real → PNG byte-idénticos; 19 tokens CSS HSL base iguales carácter por carácter; tipografía (Inter Tight/Inter/IBM Plex Mono) igual en ambos; sidebar con el mismo patrón de acordeón/colapso/bloque de cuenta (8 marcadores de código verificados en ambos `Sidebar.tsx`/`AdminSidebar.tsx` + interacción real en `/resumen`). `tests/e2e/visual/paridad-restaurantes.spec.ts`, `docs/logs/REQ-UX-001/`. Nota: conteo agregado del documento (§0/§1) no recalculado en este pase, mismo tratamiento que REQ-UX-002/REQ-SEG-007/REQ-HUE-021/REQ-HUE-014. |
| REQ-UX-002 | hecho (posterior a este pase) | Cerrado en un pase posterior | Auditadas las 20 pantallas reales de `apps/web/src/pages/**` contra `apps/api` real + embedded-postgres; 3 defectos reales corregidos (`Reputacion.tsx` atribución falsa a "credenciales" para un módulo sin backend; `AppShell.tsx` sin aviso cuando `GET /hoteles` falla, dejando a todas las pantallas mostrar su vacío genérico como si el hotel fuera real; `Reservas.tsx` selector sin indicio de error). `tests/e2e/estados-vacios-honestos.spec.ts`: 11/11 desktop + 11/11 mobile. Ver `docs/ACEPTACION.md` y `docs/logs/REQ-UX-002/`. |
| REQ-UX-003 | pendiente | Rediseño | Auditoría de accesibilidad (teclado/contraste/ARIA) y móvil de toda la `hotel-staff-pwa` es un proyecto propio. |

**Distribución de las 113 filas P0 no-hechas por clasificación:** Credenciales 45, Pendiente
sin razón 39 (+1 caso de desincronización documental), Parcial (construcción en curso) 17,
Hardware 6, Rediseño 3, Decisión del usuario 2.

## 5. Verificación de evidencia (muestreo — 100% de la población `hecho`)

`ACEPTACION.md` marca **23** de sus 276 filas con Estado que arranca en "hecho" — muy por
debajo del ≥40 asumido por la tarea. Se verificaron las 23 (100%, no una muestra parcial),
confirmando en cada caso que el archivo de prueba/script citado existe en el árbol y que el
log citado existe y muestra un resultado verde nombrando ese archivo:

```
# Existencia de los 24 archivos de prueba/script citados por las 23 filas "hecho"
for f in tests/adversarial/rpc-security-definer.spec.ts tests/unit/domain-hotel/cancelacion-policy.spec.ts \
  tests/adversarial/cancelacion-identidad.spec.ts tests/integration/reservas/overbooking-controlado.spec.ts \
  scripts/checks/no-ota-directa.ts tests/integration/folio/event-sourcing.spec.ts scripts/checks/no-delete-events.ts \
  scripts/checks/no-pan-storage.ts tests/adversarial/boveda-identidad.spec.ts tests/unit/domain-hotel/motor-precio-total.spec.ts \
  tests/adversarial/benchmark-k-minimo.spec.ts scripts/checks/orden-conectores-pms.ts \
  tests/unit/mcp-servers/pms/registro-conectores.spec.ts tests/integration/revenue/night-audit.spec.ts \
  tests/integration/revenue/night-audit-scheduler.spec.ts tests/integration/cfdi/idempotencia-timbrado.spec.ts \
  tests/adversarial/presentacion-sat-aprobacion.spec.ts tests/unit/gob/backlog-state-machine.spec.ts \
  tests/unit/gob/no-comandos-destructivos-agente.spec.ts scripts/checks/no-comandos-destructivos-agente.ts \
  tests/unit/schema/dinero-numeric.spec.ts tests/unit/check-migraciones.spec.ts scripts/check-migraciones.ts \
  tests/integration/contracts/whatsapp/aprobaciones-boton.spec.ts tests/unit/domain-hotel/impuestos-hospedaje.spec.ts; do
  [ -f "$f" ] && echo "OK $f" || echo "MISS $f"
done
# resultado: 24/24 OK, 0 MISS

# Verdes citados, confirmados sobre los logs reales:
grep -E "Test Files|Tests  |exit code|OK \(|^check-" docs/logs/p0-test-20260906-101549.log
grep -E "Test Files|Tests  " docs/logs/h1-test-unit-20260906-045521.log docs/logs/h4-test-unit-20260906-072138.log \
  docs/logs/h4-test-adversarial-20260906-072138.log docs/logs/h4-test-integration-20260906-072138.log \
  docs/logs/h5-test-integration-20260906-082126.log docs/logs/h5-test-adversarial-20260906-082126.log \
  docs/logs/h5-test-unit-20260906-082126.log docs/logs/h8-ci-npm-audit.log
cat docs/logs/h8-ci-check-migraciones.log docs/logs/h5-checks-no-pan-storage-20260906-082126.log

# Re-ejecución en vivo de los 2 checks estáticos sin log fresco citado explícitamente por nombre exacto:
node --experimental-strip-types scripts/checks/no-ota-directa.ts
node --experimental-strip-types scripts/checks/no-delete-events.ts
# resultado: ambos "OK: 0 ..." (exit 0), consistente con lo citado en ACEPTACION.md/REQUISITOS.md
```

**Resultado: 23/23 evidencias existen y están en verde.** Ninguna evidencia inválida en el
sentido estricto (archivo inexistente o log en rojo). El hallazgo real es de **etiquetado**:

### Hallazgos de la verificación (degradaciones aplicadas)

| REQ | Etiqueta en ACEPTACION.md | Degradado a | Motivo |
|---|---|---|---|
| REQ-BO-001 | hecho (offline, PAC simulado) | `pendiente-credenciales` | El propio texto admite "PAC real (Finkok/SW Sapien) y CSD del hotel: pendiente de credenciales" — ACEPTACION.md §1.2 prohíbe declarar "hecho" cuando la integración real de un conector (no solo un chequeo estático) sigue sin credencial. |
| REQ-BO-002 | hecho (offline, PAC simulado) | `pendiente-credenciales` | Mismo motivo: "PAC real: pendiente de credenciales". |
| REQ-BO-006 | hecho (offline, a nivel de BD) | `pendiente-credenciales` | "presentación real ante el SAT con e.firma real: pendiente de credenciales fiscales". |
| REQ-UX-006 | hecho offline | `pendiente-credenciales` | El propio texto dice "integración real con Meta pendiente de credenciales" — mismo patrón. |
| REQ-REV-013 | hecho (independiente del PMS) | `parcial` | La conciliación A&B/spa contra POS —parte explícita del criterio de aceptación— se reporta honestamente `sin_pos_configurado`: no está construida (no es un simple gate de credencial, es una funcionalidad ausente). |

Estos 5 casos **no** son evidencia falsa: la prueba citada existe y pasa. Es la propia
ACEPTACION.md la que, en su columna Estado, usó la palabra "hecho" para un alcance que su
propio §1 (principios) define como no-completo. Este documento aplica el estándar de ACEPTACION.md
con más rigor que la propia tabla de origen.

### Hallazgo adicional: desincronización ACEPTACION.md ↔ PROGRESO.md (H7)

`docs/PROGRESO.md` (entrada H7, 2026-09-06) declara `REQ-AGT-003` "hecho", `REQ-AGT-020`
"hecho" y `REQ-AGT-022` "verificado por adversarial", con evidencia real y verde
(`docs/logs/h7-test.log`: `tests/unit/agent-core/roi-tools.spec.ts` 3/3,
`tests/integration/api/agentes.spec.ts` 7/7, `tests/adversarial/agentes-aislamiento.spec.ts`
9/9). Sin embargo, la fila correspondiente en `docs/ACEPTACION.md` **nunca fue actualizada**
para estos 3 REQ — su columna Estado sigue diciendo literalmente "pendiente". Como este
documento deriva el Estado canónico de `ACEPTACION.md` (fuente de verdad declarada por la
tarea), estos 3 REQ quedan clasificados `pendiente` en `docs/REQUISITOS.md`, con esta nota de
desincronización documentada en vez de una reclasificación unilateral. **Acción recomendada**:
actualizar `docs/ACEPTACION.md` para REQ-AGT-003/020/022 en el próximo pase que toque ese
documento.

### Inconsistencias de vocabulario notadas (no requieren degradación, ya resueltas por regla)

`REQ-TEN-001` ("hecho (H1, parcial)..."), `REQ-BO-008` ("hecho (parcial, a nivel de BD)"),
`REQ-GOB-010` ("hecho (H1, parcial)") y `REQ-REC-012`/`REQ-QA-009` ("pendiente (parcial...)")
mezclan las palabras "hecho"/"pendiente" con "parcial" en la misma celda. Se resolvieron con
la regla de §1.2 (si el propio texto se autodescribe parcial, el Estado canónico es `parcial`)
— documentado aquí porque revela que `ACEPTACION.md` no usa su propio vocabulario de forma
consistente.

## 6. Paridad de IDs REQUISITOS ↔ ACEPTACION y conteos de cabecera

```
$ diff <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/REQUISITOS.md | sort -u) \
       <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/ACEPTACION.md | sort -u)
# (sin salida — diff vacío, 276 IDs idénticos en ambos documentos)

$ grep -c '^| REQ-' docs/REQUISITOS.md
276
$ grep -c '^| REQ-' docs/ACEPTACION.md
276
```

Ambos comandos se corrieron sobre el árbol ya actualizado por este pase (después de escribir
Estado/Evidencia en `docs/REQUISITOS.md`) — el `grep -o 'REQ-[A-Z]*-[0-9]*'` captura el ID de
cada fila sin verse afectado por el contenido nuevo de Evidencia. **Resultado: diff vacío,
276=276.** La tabla de conteos por módulo/prioridad de `docs/REQUISITOS.md` §0 (verificada de
nuevo programáticamente en este pase) sigue cuadrando exactamente contra las 276 filas reales:
TEN 6, RES 22, HUE 27, REC 14, HK 22, AB 14, REV 19, CRM 11, BO 37, AGT 22, INT 15, SEG 19,
OBS 11, UX 6, QA 10, GOB 21 → total 276; por prioridad P0 128 / P1 85 / P2 53 / P3 10 → total
276. Ninguna de las dos tablas necesitó corrección.

## 7. Comandos usados en este pase (pegados, no resumidos)

```bash
# Conteo de filas y verificación del patrón "| pendiente | |" antes de escribir
grep -cE '^\| REQ-[A-Z]+-[0-9]+ \|.*\| pendiente \|\s*\|$' docs/REQUISITOS.md   # → 276
grep -cE '^\| REQ-[A-Z]+-[0-9]+ \|' docs/REQUISITOS.md                          # → 276

# Localización de las filas no-"pendiente liso" en ACEPTACION.md (41 filas)
grep -nE '^\| REQ-' docs/ACEPTACION.md | grep -viE '\| pendiente \|$'

# Extracción programática de Prioridad/Dependencia externa (REQUISITOS.md) y
# Depende-de-credenciales/Estado (ACEPTACION.md) por REQ-ID, y paridad de conjuntos
python3 - <<'PY'
import re
req = {}
for line in open('docs/REQUISITOS.md', encoding='utf-8'):
    m = re.match(r'^\| (REQ-[A-Z]+-\d+) \|', line)
    if m:
        p = [x.strip() for x in line.strip().split('|')]
        req[p[1]] = {'prioridad': p[4], 'dependencia': p[6]}
acc = {}
for line in open('docs/ACEPTACION.md', encoding='utf-8'):
    m = re.match(r'^\| (REQ-[A-Z]+-\d+) \|', line)
    if m:
        p = [x.strip() for x in line.strip().split('|')]
        acc[p[1]] = {'depende': p[-3], 'estado': p[-2]}
print(len(req), len(acc), set(req)-set(acc), set(acc)-set(req))
PY

# Verificación de evidencia de los 23 renglones "hecho" (existencia + log verde) — ver §5
node --experimental-strip-types scripts/checks/no-ota-directa.ts
node --experimental-strip-types scripts/checks/no-delete-events.ts

# Paridad de IDs final y conteos de cabecera (post-escritura)
diff <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/REQUISITOS.md | sort -u) \
     <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/ACEPTACION.md | sort -u)
grep -c '^| REQ-' docs/REQUISITOS.md
grep -c '^| REQ-' docs/ACEPTACION.md
```

## 8. Qué no se hizo (límites de este pase, declarados)

- No se corrigió `docs/ACEPTACION.md` (fuera del mandato: solo se leyó como fuente). La
  desincronización de REQ-AGT-003/020/022 (§5) queda documentada, no reparada.
- La clasificación fina "pendiente-decisión" se aplicó solo a los 2 casos con evidencia
  textual explícita de "requiere aprobación del fundador" (`REQ-SEG-001`, `REQ-TEN-006`).
  Es posible que una lectura más profunda de `REQ-GOB-012` (catálogo de 25+ dominios
  reservados) identifique más candidatos entre los 130 `pendiente` genéricos; no se hizo
  ese análisis exhaustivo en este pase por presupuesto de tiempo — queda como trabajo futuro
  explícito, no oculto.
- No se re-ejecutó la suite completa de pruebas (`npm test`) de punta a punta; se verificó
  cada evidencia citada contra su log ya guardado (o, en 2 casos de scripts de revisión
  estática, se re-ejecutó el script puntual), consistente con el alcance de "trazabilidad"
  y no de "re-auditoría técnica completa".

## 9. Renumeración REQ-LAUNCH (merge H12a+H12b+H12c→main, integrador)

H12a, H12b y H12c se trabajaron en worktrees paralelos, cada uno sin ver el trabajo de
los otros dos. Los tres numeraron requisitos nuevos como `REQ-LAUNCH-nnn`, pero con
convenciones distintas: H12b intentó alinear sus IDs con el `LAUNCH-nnn` canónico de
`docs/referencia/08-inventario-punta-a-punta.md` §3 (huecos LAUNCH-001..029); H12a y
H12c, en cambio, numeraron secuencialmente desde 001 sin atarse a ese inventario. Al
fusionar los tres al mismo `main`, esto produjo colisiones reales: `REQ-LAUNCH-007`,
`REQ-LAUNCH-009` y `REQ-LAUNCH-010` cada uno tenía DOS requisitos distintos con el mismo
ID (H12a y H12b), y `REQ-LAUNCH-001` a `REQ-LAUNCH-015` tenía hasta TRES candidatos
distintos por número (H12a, H12c, y en algunos casos también H12b).

**Criterio de resolución (integrador, merge de H12c a `main`):**
1. Se conservan sin cambio los 4 IDs de H12b que ya coincidían 1:1 con el `LAUNCH-nnn`
   canónico del inventario: `REQ-LAUNCH-007` (superadmin), `REQ-LAUNCH-009` (export
   Supabase), `REQ-LAUNCH-010` (despliegue), `REQ-LAUNCH-021` (CSP) — renombrarlos habría
   tocado más archivos de código/tests que dejarlos.
2. El `REQ-LAUNCH-028` que H12b había usado para SEO/PWA se renumera a `REQ-LAUNCH-060`:
   colisionaba con el `LAUNCH-028` REAL del inventario ("simulador de demo end-to-end",
   sin cubrir todavía por ningún hito) — el trabajo de SEO/PWA de H12b no corresponde a
   ningún `LAUNCH-nnn` dedicado del inventario (cita "filas 28 y 30" de la tabla, no IDs).
3. Los 14 requisitos de H12a (antes `REQ-LAUNCH-001..014`, numeración secuencial propia)
   se renumeran a `REQ-LAUNCH-031..044`.
4. Los 15 requisitos de H12c (antes `REQ-LAUNCH-001..015`, numeración secuencial propia)
   se renumeran a `REQ-LAUNCH-045..059`.
5. Ningún ID nuevo colisiona entre sí ni con los 4+1 de H12b conservados/renumerados
   (verificado: `grep -o 'REQ-LAUNCH-[0-9]*' docs/REQUISITOS.md | sort | uniq -c` sin
   ninguna fila con conteo > 1).

### Tabla de mapeo (ID antiguo por hito → ID canónico)

| Hito | ID antiguo | ID canónico | Requisito (resumen) |
|---|---|---|---|
| H12a | REQ-LAUNCH-001 | REQ-LAUNCH-031 | Login/vinculación Google OAuth (Authorization Code+PKCE) |
| H12a | REQ-LAUNCH-002 | REQ-LAUNCH-032 | `hotel_staff_identity` con RLS |
| H12a | REQ-LAUNCH-003 | REQ-LAUNCH-033 | 503 `no_configurado` sin credenciales Google |
| H12a | REQ-LAUNCH-004 | REQ-LAUNCH-034 | `POST /registro` atómico + verificación de correo |
| H12a | REQ-LAUNCH-005 | REQ-LAUNCH-035 | Rate limit dedicado de `/registro` |
| H12a | REQ-LAUNCH-006 | REQ-LAUNCH-036 | Onboarding guiado (tipos de habitación, zona horaria, invitar equipo) |
| H12a | REQ-LAUNCH-007 | REQ-LAUNCH-037 | Invitación de staff por correo (token de un solo uso) |
| H12a | REQ-LAUNCH-008 | REQ-LAUNCH-038 | "Olvidé mi contraseña" |
| H12a | REQ-LAUNCH-009 | REQ-LAUNCH-039 | Cambio de correo con token a la dirección nueva |
| H12a | REQ-LAUNCH-010 | REQ-LAUNCH-040 | `packages/email`: `EmailPort` + adaptadores Resend/SMTP/Fake |
| H12a | REQ-LAUNCH-011 | REQ-LAUNCH-041 | 12 plantillas HTML de correo |
| H12a | REQ-LAUNCH-012 | REQ-LAUNCH-042 | `npm run email:preview` |
| H12a | REQ-LAUNCH-013 | REQ-LAUNCH-043 | Disparadores de correo por `public.outbox` |
| H12a | REQ-LAUNCH-014 | REQ-LAUNCH-044 | Batería adversarial de OAuth/cuenta |
| H12c | REQ-LAUNCH-001 | REQ-LAUNCH-045 | SaaS al hotel: planes Starter/Pro/Enterprise, trial 14 días |
| H12c | REQ-LAUNCH-002 | REQ-LAUNCH-046 | Precios marcados `es_propuesta = true` |
| H12c | REQ-LAUNCH-003 | REQ-LAUNCH-047 | `BillingProviderPort` intercambiable |
| H12c | REQ-LAUNCH-004 | REQ-LAUNCH-048 | Webhook de facturación HMAC + idempotente |
| H12c | REQ-LAUNCH-005 | REQ-LAUNCH-049 | `check_entitlement()`/límites de plan fail-closed |
| H12c | REQ-LAUNCH-006 | REQ-LAUNCH-050 | Aislamiento por tenant de suscripción/facturas |
| H12c | REQ-LAUNCH-007 | REQ-LAUNCH-051 | CFDI del SaaS (Atiende facturando al hotel) |
| H12c | REQ-LAUNCH-008 | REQ-LAUNCH-052 | Centro de notificaciones in-app |
| H12c | REQ-LAUNCH-009 | REQ-LAUNCH-053 | Campana de notificaciones con contador real |
| H12c | REQ-LAUNCH-010 | REQ-LAUNCH-054 | Aislamiento de notificaciones por destinatario/tenant |
| H12c | REQ-LAUNCH-011 | REQ-LAUNCH-055 | Preferencia de notificación por usuario |
| H12c | REQ-LAUNCH-012 | REQ-LAUNCH-056 | `AnalyticsPort`/`ErrorReporterPort` con opt-in |
| H12c | REQ-LAUNCH-013 | REQ-LAUNCH-057 | Catálogo cerrado de eventos de producto |
| H12c | REQ-LAUNCH-014 | REQ-LAUNCH-058 | Landing pública indexable en `/` |
| H12c | REQ-LAUNCH-015 | REQ-LAUNCH-059 | Banner de cookies/analítica con opt-in |
| H12b | REQ-LAUNCH-028 | REQ-LAUNCH-060 | `robots.txt`/`sitemap.xml`/PWA (SEO), sin `LAUNCH-nnn` dedicado |
| H12b | REQ-LAUNCH-007 | REQ-LAUNCH-007 (sin cambio) | Consola superadmin cross-tenant |
| H12b | REQ-LAUNCH-009 | REQ-LAUNCH-009 (sin cambio) | Export de migraciones a Supabase |
| H12b | REQ-LAUNCH-010 | REQ-LAUNCH-010 (sin cambio) | Configuración de despliegue (Vercel/Docker+Fly) |
| H12b | REQ-LAUNCH-021 | REQ-LAUNCH-021 (sin cambio) | CSP completa API+web |

**Arreglo real encontrado durante el merge (no solo renumeración):** el `robots.txt`/
`sitemap.xml` de H12b (REQ-LAUNCH-060) bloqueaban con `Disallow: /` TODO el sitio salvo
`/terminos`/`/privacidad`, bajo el supuesto de que la landing pública de venta viviría en
otro proyecto/host (comentario explícito en el `robots.txt` original). H12c construyó esa
landing DENTRO del mismo `apps/web`, en `/` (`Landing.tsx`, REQ-LAUNCH-058) — con el
`robots.txt` sin corregir, ningún crawler podía siquiera obtener esa página para
indexarla, contradiciendo directamente el propio REQ-LAUNCH-058 ("landing pública ...
indexable"). Corregido en el mismo merge: `robots.txt` permite `/` y las páginas legales,
bloquea el panel operativo autenticado; `sitemap.xml` ahora incluye `/`.

**Otro cierre real en el mismo merge:** `REQ-LAUNCH-043` (disparadores de correo por
outbox, H12a) estaba `parcial` porque `routes/reservas.ts`/`routes/cfdi.ts` (fuera del
alcance de H12a) no emitían los eventos `reservation.confirmed`/`cfdi.emitted` — ambos se
cablearon en el merge de H12a a `main` (antes de que existiera H12c), con prueba nueva en
`tests/integration/api/email-outbox-handlers.spec.ts`; el estado pasó a `hecho`.

Verificación tras la renumeración: `diff` de IDs `REQ-LAUNCH-*` entre `docs/REQUISITOS.md`
y `docs/ACEPTACION.md` vacío (mismo conjunto de IDs en ambos documentos); ningún
`REQ-LAUNCH-nnn` duplicado en ninguno de los dos archivos.
