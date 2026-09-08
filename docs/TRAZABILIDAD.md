# Trazabilidad — Atiende Hoteles

Fecha del pase: **2026-09-06**. Agente: Sonnet (trazabilidad). Rama: `main`. Fuentes leídas
completas: `docs/REQUISITOS.md` (276 REQ-* canónicos), `docs/ACEPTACION.md` (276 criterios de
aceptación con Estado/Evidencia por hito), `docs/cierre-p0/inventario.md` (inventario de P0
`ninguna`-dependencia pendientes de cierre, con razón por ID), `docs/PROGRESO.md` (bitácora de
hitos H1–H9/H11 y auditoría-1). Este documento no inventa evidencia: cada estado canónico
derivado se apoya en un archivo de prueba real y un log real bajo `docs/logs/`, ambos
confirmados en el árbol de trabajo el día de este pase (comandos en §5).

## 0. Resumen ejecutivo (sin maquillaje)

- **Estado canónico de los 276 REQ**: 18 `hecho` (6.5%), 19 `parcial` (6.9%), 87
  `pendiente-credenciales` (31.5%), 20 `pendiente-hardware` (7.2%), 3 `pendiente-decisión`
  (1.1%, ver nota §8: se sumó `REQ-AGT-013` el 2026-09-08, mismo criterio de
  `REQ-SEG-001`/`REQ-TEN-006` — evidencia textual explícita de decisión reservada al
  fundador, aquí LLM-023), 129 `pendiente` sin dependencia externa resuelta (46.7%).
- **P0 (128 requisitos)**: solo **15 hechos = 11.7%**. El resto: 17 parciales, 45
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
| P0 | 15 | 17 | 45 | 6 | 2 | 43 | 128 | **11.7%** |
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
| REQ-AGT-004 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-006 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-008 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-009 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo); además requiere su propio simulador de huéspedes (red-teaming en CI), no construido. |
| REQ-AGT-013 | pendiente-decisión | Decisión del usuario | Reclasificado 2026-09-08 (lectura más profunda, exactamente el caso que §8 de este documento dejaba como trabajo futuro explícito): `docs/ARQUITECTURA.md` "Resolución de las 10 contradicciones" #10 cita LLM-023 exigiendo confirmación separada del fundador antes de desplegar un motor de OCR de origen chino (PaddleOCR-VL/GLM-OCR/Qwen3-Embedding) en producción, distinta de la aprobación de la Opción C — ver `docs/BLOQUEOS.md` D-006. El guardrail estático que sí es verificable sin esa decisión se construyó y quedó en verde: `scripts/checks/ocr-aislado-sin-internet.ts` (0 llamadas a LLM de canal/endpoint chino para OCR) + `tests/unit/agent-core/ocr-aislado-sin-internet.spec.ts` (9/9, adversarial) · `docs/logs/REQ-AGT-013/`. |
| REQ-AGT-015 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-016 | pendiente-credenciales | Credenciales | pendiente — depende de: telefonía/voz |
| REQ-AGT-018 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-019 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo). |
| REQ-AGT-022 | pendiente | Pendiente sin razón | Excluido explícitamente del pase de cierre P0 (frente H7 en paralelo); nota: hay evidencia verde de aislamiento de contexto en `tests/adversarial/agentes-aislamiento.spec.ts` (H7, `docs/logs/h7-test.log`) no reflejada en ACEPTACION.md — mismo patrón de desincronización que REQ-AGT-003. |
| REQ-BO-001 | pendiente-credenciales | Credenciales | Offline (PAC simulado): `tests/integration/contracts/cfdi/hospedaje.spec.ts` (7/7) · `docs/logs/h5-test-integration-20260906-082126.log`. PAC real (Finkok/SW Sapien) y CSD del hotel: pendiente de credenciales — degradado de "hecho" (ACEPTACION.md) a `pendiente-credenciales` por criterio estricto de este documento. |
| REQ-BO-002 | pendiente-credenciales | Credenciales | Offline (PAC simulado): `tests/integration/cfdi/idempotencia-timbrado.spec.ts` (4/4) · `docs/logs/h5-test-integration-20260906-082126.log`. PAC real: pendiente de credenciales — degradado de "hecho" a `pendiente-credenciales`. |
| REQ-BO-006 | pendiente-credenciales | Credenciales | Offline (a nivel de BD): `tests/adversarial/presentacion-sat-aprobacion.spec.ts` (4/4) · `docs/logs/h5-test-adversarial-20260906-082126.log`. Presentación real ante el SAT con e.firma real: pendiente — degradado de "hecho" a `pendiente-credenciales`. |
| REQ-BO-008 | parcial | Parcial (construcción en curso) | 2/2 tests de integración sobre `fiscal_obligation` · `docs/logs/h5-test-integration-20260906-082126.log`. Sin endpoint de API CRUD todavía (pendiente de back-office posterior, no de credenciales). |
| REQ-BO-010 | pendiente | Pendiente sin razón | Requiere el motor de reporting financiero completo (P&L USALI, forecast, punto de equilibrio, caja 13 semanas); no se implementa parcialmente para evitar un P&L simulado. |
| REQ-BO-011 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-BO-014 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-BO-024 | pendiente | Pendiente sin razón | Módulo de RR.HH./nómina no construido; no existe tabla de horarios/turnos contra la cual cruzar asistencia. |
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
| REQ-GOB-016 | pendiente | Pendiente sin razón | Compartido con REQ-REV-018: requiere línea base firmada por escrito antes de activar cobro por resultado; no construido. |
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
| REQ-HUE-006 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-009 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-010 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela |
| REQ-HUE-013 | pendiente-credenciales | Credenciales | pendiente — depende de: PMS |
| REQ-HUE-014 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-015 | pendiente-credenciales | Credenciales | pendiente — depende de: telefonía/WhatsApp |
| REQ-HUE-016 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-017 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-020 | pendiente-credenciales | Credenciales | pendiente — depende de: WhatsApp |
| REQ-HUE-021 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-HUE-022 | pendiente | Pendiente sin razón | El check-in online de este pase (REQ-RES-016) no captura ningún dato biométrico (solo foto de documento para OCR, borrada tras extraer campos) — el requisito de "0 reconocimiento facial" ya se cumple estructuralmente — pero el consentimiento diferenciado explícito en UI para cualquier dato biométrico futuro queda pendiente de una pantalla dedicada. |
| REQ-HUE-023 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
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
| REQ-OBS-007 | pendiente-credenciales | Credenciales | pendiente — depende de: canales reales (WhatsApp/voz) + motor de ROI (H7); ver `docs/cierre-p0/inventario.md` §1.5 |
| REQ-OBS-010 | pendiente | Pendiente sin razón | Ya se practica informalmente (`docs/logs/*.log` por tarea en este propio pase); falta el mecanismo que lo haga obligatorio/verificable automáticamente. |
| REQ-QA-001 | pendiente | Pendiente sin razón | Regla de proceso TDD (rojo→código→refactor); sin verificación automática del orden de commits todavía. |
| REQ-QA-002 | hecho | Hecho (2026-09-08, posterior a este pase) | `scripts/checks/no-tests-skip.ts` (revisión estática autocontenida, mismo patrón que `pms-mirror-solo-lectura.ts`): prohíbe sin excepción `xit(`/`xdescribe(`/`it.skip(`/`describe.skip(` en `tests/`, y prohíbe `test.skip(` (Playwright) fuera de `tests/e2e/` o dentro de `tests/e2e/` sin un segundo argumento no vacío que documente el motivo -- distingue así los 2 usos legítimos ya existentes (`test.skip(condición, "razón")` condicional por proyecto, `test.skip(true, motivoFallo)` con motivo nombrado) de un skip que esconde un caso que falla sin explicación, que sigue prohibido. Verificado con inyección viva sobre el CLI real (`xit(` fuera de e2e → detectado; `test.skip(true)` sin motivo dentro de e2e → detectado; limpiado sin residuos) además de `tests/unit/qa/no-tests-skip.spec.ts` (16/16 verdes, incluida una prueba que corre contra `tests/` real y confirma 0 violaciones con los 5 skips condicionales documentados existentes). Cableado a CI (`.github/workflows/ci.yml`, mismo patrón de fallo rápido antes de `npm test`, ADR-009). Fuera de alcance documentado: detectar una prueba "borrada" o "comentada" requiere diffing de historial/distinguir prosa, que el propio criterio no exige automatizar (su único método de verificación es el grep estático sobre el árbol actual) -- sigue siendo, como ya notaba `docs/cierre-p0/inventario.md`, una regla de proceso de revisión humana en esa mitad. Ver `docs/ACEPTACION.md` y `docs/logs/REQ-QA-002/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-QA-003 | pendiente | Pendiente sin razón | Requiere un mecanismo de CI que lea el `gate` declarado de una tarea (ligado a GOB-007) y dispare la suite `connector`; no construido. |
| REQ-QA-004 | pendiente | Pendiente sin razón | Mismo mecanismo de runner de gates que QA-003, para el gate `money`; no construido. |
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
| REQ-REV-018 | pendiente | Pendiente sin razón | Captura de ROIEvent con supuesto versionado sí existe (H7); línea base firmada + activación de cobro por resultado sobre esa base: no construida. |
| REQ-SEG-001 | pendiente-decisión | Decisión del usuario | Es contenido legal/negocio (Aviso de Privacidad) que requiere aprobación del fundador antes de publicarse como definitivo (catálogo de decisiones reservadas, REQ-GOB-012); no se redacta un aviso legal sin esa aprobación. |
| REQ-SEG-003 | hecho | Hecho (2026-09-08, posterior a este pase) | `scripts/checks/no-biometria-facial.ts` (compartido con REQ-HUE-022: 0 reconocimiento facial en `apps/`+`packages/`) + `tests/adversarial/consentimiento-biometrico.spec.ts` (5/5 verdes, `embedded-postgres` real: un intento de colar dato biométrico en el body del check-in público, completado con éxito solo con el aviso general, persiste 0 filas en `guest`/`checkin_submission`/`identity_ref`/`consent`/`audit_log`; `consent_kind` solo admite `tratamiento_datos`/`marketing`). Ver `docs/ACEPTACION.md` y `docs/logs/REQ-SEG-003/`. Nota: el resumen ejecutivo (§0) y los conteos de este documento reflejan el estado del pase de 2026-09-06 y no se recalculan aquí. |
| REQ-SEG-005 | pendiente-credenciales | Credenciales | pendiente — depende de: pasarela |
| REQ-SEG-007 | pendiente-credenciales | Credenciales | pendiente — depende de: canal/credencial real (WhatsApp/voz), ver `docs/cierre-p0/inventario.md` §2 |
| REQ-SEG-010 | pendiente-credenciales | Credenciales | pendiente — depende de: credenciales fiscales |
| REQ-SEG-012 | pendiente | Pendiente sin razón | Requiere agregar un scanner de secretos (gitleaks) al pipeline de CI; no se tocó en el pase de cierre P0 por enfoque en app/dominio. |
| REQ-SEG-013 | pendiente-credenciales | Credenciales | pendiente — depende de: credenciales |
| REQ-SEG-014 | parcial | Parcial (construcción en curso) | `tests/adversarial/boveda-identidad.spec.ts` · `docs/logs/p0-test-20260906-101549.log`. "Doble control" pleno (2 personas aprobando la misma lectura): NO implementado. |
| REQ-SEG-015 | pendiente-hardware | Hardware | pendiente — depende de: hardware edge/cerraduras |
| REQ-TEN-001 | parcial | Parcial (construcción en curso) | `tests/unit/rls/org-isolation.spec.ts`, `tests/unit/rls/tenant-isolation.spec.ts`, `tests/adversarial/auditoria-1-bd-criticos.spec.ts` (9/9) · `docs/logs/h1-test-unit-20260906-045521.log`, `docs/logs/aud1-bd-test-20260906-075050.log`. Falta repetir la matriz de aislamiento por cada tabla de tenant nueva. |
| REQ-TEN-002 | pendiente | Pendiente sin razón | Migración estructural del modelo base `org`/`location` compartido con Restaurantes; alto riesgo de conflicto con otros frentes sobre el mismo esquema — deliberadamente no tocado en un pase de cierre P0 acotado. |
| REQ-TEN-003 | parcial | Parcial (construcción en curso) | `tests/adversarial/roles.spec.ts` (20/20) · `docs/logs/h2-test-adversarial-20260906-053949.log`. Falta `tests/e2e/staff-pwa.spec.ts` (H6). |
| REQ-TEN-006 | pendiente-decisión | Decisión del usuario | Depende de que exista contenido de disclosure real aprobado (texto legal, REQ-GOB-012) antes de tener sentido centralizarlo; construir el motor vacío sería simular el requisito. |
| REQ-UX-001 | pendiente | Rediseño | Rediseño integral de `apps/web` (paridad visual completa); alto riesgo de romper páginas existentes sin revisión visual dedicada. |
| REQ-UX-002 | pendiente | Rediseño | Auditar TODAS las pantallas existentes de `apps/web` con estados vacíos/errores honestos es un proyecto de UX propio (más allá de las 2 pantallas nuevas de UX-004/005 que sí lo cumplen). |
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
