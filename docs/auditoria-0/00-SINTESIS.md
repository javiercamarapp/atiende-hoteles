# Síntesis — Ronda de corrección auditoría 0 (Sonnet)

Agente de corrección (Sonnet), contexto fresco. Fuente única de hallazgos: `docs/auditoria-0/documentos.md`
(auditor Sonnet, ronda 0). Ese documento **no se modificó** — la recalificación de las notas por
documento la hará otro auditor en una ronda posterior; esta síntesis solo reporta qué se hizo con
cada hallazgo.

**Nota de conteo.** El encargo de esta ronda de corrección indicaba "20 hallazgos: 2 CRÍTICOS, 7
ALTOS, 7 MEDIOS, 4 BAJOS". El conteo real en `docs/auditoria-0/documentos.md`
(`grep -c "^### \[CRÍTICO\]|^### \[ALTO\]|^### \[MEDIO\]|^### \[BAJO\]"`, aplicado por severidad) es
**19**: 2 CRÍTICO + 7 ALTO + **6** MEDIO + 4 BAJO. Se trabajaron los 19 hallazgos reales del
documento, no 20; se deja constancia de la discrepancia con el encargo en vez de inventar un
vigésimo hallazgo inexistente.

## Tabla de los 19 hallazgos

| # | Severidad | Título | Estado | Commit(s) |
|---|---|---|---|---|
| 1 | CRÍTICO | GOB-025 (aislamiento de contexto entre tenants en los prompts) no está citado ni excluido | **arreglado** | `67421a3` |
| 2 | CRÍTICO | ADR-003 decide un cambio de proveedor de base de datos sin la aprobación del fundador que el propio catálogo de gobierno exige | **arreglado** | `8a45d7a` |
| 3 | ALTO | El conteo de cabecera del módulo GOB no cuadra con sus propias filas | **arreglado** | `35b0cf5` |
| 4 | ALTO | Modelo de tenencia contradictorio entre REQUISITOS.md y ARQUITECTURA.md, citando la misma fuente | **arreglado** | `42f21c1` |
| 5 | ALTO | Ningún documento posterior a REQUISITOS.md cita un solo REQ-* canónico | **arreglado** | `cb4d2e6` (más citas incidentales en `a87b353`, `0fe1e7c`, `afae6fc`) |
| 6 | ALTO | La matriz de roles de ADR-004 no coincide con los roles exigidos por REQ-TEN-003 (misma fuente citada) | **arreglado** | `afae6fc` |
| 7 | ALTO | Dominio Energía/IoT/HVAC/cerraduras sin ningún ADR, puerto ni hito, pese a tener 5+ requisitos P0 | **arreglado** | `a87b353` |
| 8 | ALTO | Las 10 contradicciones que REQUISITOS.md delega explícitamente a ARQUITECTURA.md no se resuelven por nombre en ninguna | **arreglado** | `0fe1e7c` |
| 9 | ALTO | 88 IDs de origen (13.8% de ≈640) no están citados en ninguna fila ni en la tabla de exclusión, pese a declararse solo 20 excluidos | **arreglado** | `67421a3` (arreglado junto con el hallazgo CRÍTICO #1 — GOB-025 era uno de los 88; los 87 restantes se rutearon en el mismo commit para no dejar el documento en un estado intermedio inconsistente) |
| 10 | MEDIO | `hotel-staff-pwa` se cita en dos requisitos pero ARQUITECTURA.md nunca lo define ni lo trata como PWA | **arreglado** | `bd59010` |
| 11 | MEDIO | El "catálogo cerrado" de decisiones reservadas al fundador (REQ-GOB-012) omite ítems presentes en su propia fuente citada | **arreglado** | `109aa4e` |
| 12 | MEDIO | REQ-RES-001 cita como fuente un requisito que no trata sobre cotización | **arreglado** | `32b4fe8` |
| 13 | MEDIO | REQ-RES-022 omite el calificador temporal de su fuente y lo presenta como prohibición permanente | **arreglado** | `26cafa6` |
| 14 | MEDIO | Página de fuente citada incorrectamente para H04-018 (registro de jornada 2027) | **pendiente** — la cita errónea vive en `docs/referencia/02-investigacion-H01-H11.md:276` ("H04, p.14" en vez de p.13), un archivo protegido explícitamente para este agente ("extractos de fuente", no tocar). No hay arreglo posible dentro del mandato de esta ronda sin violar esa restricción. | — |
| 15 | MEDIO | Prioridad inconsistente entre requisitos de accesibilidad/móvil derivados del mismo párrafo del encargo | **arreglado** | `4e7cfb9` |
| 16 | BAJO | REQ-HUE-001 funde dos SLA de primera respuesta distintos sin señalar el conflicto | **arreglado** | `699eb49` |
| 17 | BAJO | REQ-HUE-007 cita como fuente una suite de evals pre-release, no una auditoría de producción | **arreglado** | `782c14f` |
| 18 | BAJO | Dos celdas con texto roto en la tabla de hitos de ARQUITECTURA.md | **arreglado** | `17ed607` |
| 19 | BAJO | `docs/audits/enterprise-remediation-2026-09-04.md`, citado por ADR-002, no existe en este repositorio | **arreglado** | `42af2a9` |

**Resumen por severidad:** CRÍTICO 2/2 arreglados · ALTO 7/7 arreglados · MEDIO 5/6 arreglados, 1
pendiente (razón: archivo protegido) · BAJO 4/4 arreglados. Ningún hallazgo resultó falso
("descartado") en la verificación propia contra los archivos y las fuentes citadas; los 19 se
confirmaron reales antes de corregirlos.

## Qué cambió, en síntesis

- **REQUISITOS.md**: +6 REQ-* nuevos (`REQ-AGT-022` aislamiento de contexto por tenant, `REQ-HUE-027`
  hilo único de WhatsApp, `REQ-BO-036` solar, `REQ-BO-037` huella de carbono, `REQ-SEG-019`
  analítica de video CCTV, `REQ-OBS-011` alcanzabilidad `wa_id`) — total 270→276; 99 citas de fuente
  añadidas a requisitos existentes para rutear los 87 IDs de origen restantes que quedaban sin
  destino; 1 nuevo grupo de exclusión (roadmap 2029, H06-018); correcciones de texto en
  REQ-RES-001, REQ-RES-022, REQ-REV-008, REQ-HUE-001, REQ-HUE-007, REQ-GOB-012, REQ-UX-003; tabla de
  conteos de cabecera recalculada por completo y verificada por awk.
- **ACEPTACION.md**: +6 filas de criterio de aceptación para los REQ nuevos; hito **H11** añadido a
  "Compuertas por hito" (energía/IoT/cerraduras); referencias de conteo actualizadas (270→276,
  H1..H10→H1..H11); corregido el comando de verificación de cobertura (`grep -c "^| REQ-"` anclado).
- **ARQUITECTURA.md**: nuevo **ADR-011** (puerto edge/IoT: `EnergyPort`/`LockPort`, adaptador
  simulado etiquetado, PENDIENTE DE HARDWARE/CREDENCIALES); ADR-003 reencuadrado (Supabase sigue
  siendo producción; PGlite/`embedded-postgres` son solo entorno local); ADR-004 corregido
  (tenant=`org`, matriz de roles alineada 1:1 con REQ-TEN-003); nueva sección "Resolución de las 10
  contradicciones de REQUISITOS.md §4"; "Requisitos que cubre" añadido a los 11 ADR; hitos H1-H11
  con REQ-* citados; 2 celdas de texto roto limpiadas; aclarada la ruta externa de
  `docs/audits/...`; PWA real decidida para `hotel-staff-pwa` (manifest + service worker, sin
  offline-first de datos).
- **BLOQUEOS.md**: +4 entradas (D-001 proveedor de BD de producción, D-002 confirmación final de la
  Opción C, D-003 umbrales/contenido de protocolos de huracán, D-004 cerraduras y "hotel sin
  recepción nocturna") — todas expuestas como decisión pendiente del usuario, ninguna bloquea el
  trabajo de construcción local; corregida la nota de B-002 (vitest resuelto real 4.1.11, no 5.0.0;
  decisión de stack ya no "pendiente").
- **docs/auditoria/RUBROS.md** y **docs/auditoria/AUDITOR-PROMPT.md**: terminología tenant=org
  corregida; "Requisitos-ancla (REQ-*)" añadido a los 12 rubros.

## Notas por documento (del auditor original, sin cambios — la recalificación es de otro auditor)

- **`docs/REQUISITOS.md` — 7/10.** El contenido de cada fila es, en la muestra verificada (~56
  requisitos), fiel a sus fuentes: no se encontró ningún requisito inventado ni un ID de fuente que
  diga lo contrario de lo que el requisito afirma. Sí aparecen citas infladas o forzadas puntuales
  (ver hallazgos MEDIO/BAJO). Baja de 10 a 7 porque el documento se equivoca sobre su propia
  completitud: el conteo de cabecera del módulo GOB no cuadra con sus propias filas, y la tabla de
  "20 IDs excluidos deliberadamente" deja fuera —sin citar ni excluir— 88 IDs de origen reales
  (13.8% de los ≈640), incluida `GOB-025`, la única regla de gobierno que exige aislar el contexto
  de un agente entre tenants a nivel de prompt (no de base de datos).
- **`docs/ARQUITECTURA.md` — 6/10.** Las diez ADR citan evidencia verificable línea por línea; las
  cifras empíricas de rendimiento (1344 ms PGlite serializado, 302 ms `embedded-postgres`
  concurrente) están confirmadas literalmente en `07-stack-viabilidad.md`, y el tratamiento de
  integraciones "pendiente de credenciales" es honesto y sin excepciones ocultas. Baja de 10 a 6
  por acumulación de brechas de coherencia hacia el documento que se supone que implementa: nunca
  cita un solo `REQ-*` canónico (0 ocurrencias en todo el archivo), no resuelve ninguna de las 10
  contradicciones que `REQUISITOS.md` le delega explícitamente por nombre, deja el dominio completo
  de energía/IoT/HVAC/cerraduras sin ADR ni hito pese a tener varios requisitos P0, contradice a
  `REQUISITOS.md` sobre qué es el tenant (`hotel` vs `org`), define una matriz de roles distinta a
  la que exige el requisito que cita como fuente, y resuelve unilateralmente (sin marcar
  `needs-human`) una decisión que el propio catálogo de gobierno que este proyecto reconoce como
  cerrado (`REQ-GOB-012`/`REQ-AGT-011`, fuente GOB-051/LLM-022) reserva al fundador.
- **`docs/auditoria/RUBROS.md` — 8/10.** Documento sólido y bien calibrado: anclas de calificación
  concretas con valores reales, ejemplos de hallazgo con "entra X → sale Y mal" ya modelados, y
  todas las referencias a ADR/GOB verificadas (ADR-002 a ADR-010, GOB-013/026/032/059) citan
  contenido real y consistente. No se detectaron afirmaciones fácticas propias que contradigan las
  fuentes. Como el resto del corpus, tampoco cita ningún `REQ-*` (ver hallazgo ALTO compartido).
- **`docs/auditoria/AUDITOR-PROMPT.md` — 8/10.** Protocolo bien pensado (prohíbe proponer arreglos,
  exige contar lo revisado, pide la nota antes de la lista de hallazgos), consistente con
  `RUBROS.md` y con el mecanismo real de Likida descrito en `06-backoffice-agentes-likida.md` §4.
  No se detectaron afirmaciones verificables propias fuera de proceso/formato que fallen.
- **`docs/BLOQUEOS.md` — 6/10.** B-001 está documentado con evidencia de búsqueda real y
  verificable. B-002 tiene dos defectos: cita `vitest@5.0.0` como "resolvible" cuando la propia
  investigación del mismo día (`07-stack-viabilidad.md`, Experimento 1) registra que la instalación
  real resolvió `vitest@4.1.11` y señala explícitamente que 5.0.0 era una lectura de "un chequeo
  anterior"; además sigue describiendo la elección de stack como "decisión... pendiente del agente
  de arquitectura" cuando `ARQUITECTURA.md` (mismo día) ya la tomó y documentó (ADR-003) sin que
  `BLOQUEOS.md` se haya actualizado para reflejarlo.
- **`docs/operacion-bucle.md` — 7/10.** Internamente consistente, sin contradicciones detectables
  contra el resto del corpus, y honesto sobre el alcance real de los mecanismos (`/loop` solo-sesión,
  autoexpiración del cron a 7 días, condición de parada verificable). La única evidencia que pude
  cotejar de forma independiente (`docs/logs/bucle.log`) corrobora, no contradice, lo que el
  documento afirma sobre el primer disparo del cron `f24bfd35`; el resto de sus afirmaciones
  operativas (estado de sesión, agentes en curso) queda fuera de lo verificable desde archivos.

## Verificación final de conteos (comando + salida real)

```
$ awk -F'|' '/^\| REQ-/{id=$2; gsub(/^ +| +$/,"",id); mod=id; sub(/^REQ-/,"",mod); sub(/-[0-9]+$/,"",mod); prio=$5; gsub(/^ +| +$/,"",prio); print mod, prio}' docs/REQUISITOS.md | sort | uniq -c | awk '{sum[$2]+=$1; tot+=$1} END{for (m in sum) print m, sum[m]; print "TOTAL", tot}' | sort
AB 14
AGT 22
BO 37
CRM 11
GOB 21
HK 22
HUE 27
INT 15
OBS 11
QA 10
REC 14
RES 22
REV 19
SEG 19
TEN 6
TOTAL 276
UX 6

$ sed -n '9,27p' docs/REQUISITOS.md   # tabla de cabecera "0. Conteos"
| Módulo | Requisitos canónicos | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| TEN | 6 | 5 | 0 | 1 | 0 |
| RES | 22 | 5 | 9 | 8 | 0 |
| HUE | 27 | 16 | 8 | 3 | 0 |
| REC | 14 | 8 | 6 | 0 | 0 |
| HK | 22 | 7 | 8 | 6 | 1 |
| AB | 14 | 2 | 6 | 5 | 1 |
| REV | 19 | 8 | 6 | 5 | 0 |
| CRM | 11 | 2 | 4 | 4 | 1 |
| BO | 37 | 14 | 13 | 5 | 5 |
| AGT | 22 | 13 | 5 | 4 | 0 |
| INT | 15 | 7 | 5 | 2 | 1 |
| SEG | 19 | 10 | 6 | 2 | 1 |
| OBS | 11 | 7 | 1 | 3 | 0 |
| UX | 6 | 3 | 2 | 1 | 0 |
| QA | 10 | 7 | 2 | 1 | 0 |
| GOB | 21 | 14 | 4 | 3 | 0 |
| **Total** | **276** | **128** | **85** | **53** | **10** |

Cabecera cuadra 1:1 con el conteo real por módulo y por prioridad (verificado línea por línea contra
el bloque anterior).

$ diff <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/REQUISITOS.md | sort -u) <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/ACEPTACION.md | sort -u)
(sin salida — mismo conjunto exacto de 276 IDs en ambos documentos)

$ grep -c "^| REQ-" docs/ACEPTACION.md
276

$ grep -ohE '\b(BP|LLM|GOB|H[0-9]+)-[0-9]+\b' docs/REQUISITOS.md | sort -u > /tmp/cited.txt
$ comm -23 /tmp/all_source_ids.txt /tmp/cited.txt | wc -l   # IDs de origen sin ruta (deben ser 0)
0

$ grep -oE 'REQ-[A-Z]+-[0-9]+' docs/ARQUITECTURA.md docs/auditoria/RUBROS.md docs/auditoria/AUDITOR-PROMPT.md | wc -l
269   (antes de esta ronda: 0)

$ grep -c "^## ADR-" docs/ARQUITECTURA.md
11   (ADR-001..ADR-011; antes de esta ronda: 10)
```

## Lo que quedó propuesto o pendiente

- **Hallazgo #14 (MEDIO, H04-018 página incorrecta): pendiente.** El error vive en
  `docs/referencia/02-investigacion-H01-H11.md:276`, un archivo de "extractos de fuente" que esta
  ronda tiene expresamente prohibido tocar. No se cuenta como descartado (el hallazgo es real,
  verificado contra el PDF por el auditor original) ni como arreglado; queda documentado aquí para
  que una ronda con mandato distinto (o el fundador) lo corrija en el archivo de referencia.
- **D-001..D-004 en `docs/BLOQUEOS.md`**: cuatro decisiones expuestas al fundador (proveedor de BD
  de producción, confirmación final de la Opción C de LLM, umbrales/contenido de protocolos de
  huracán, integración de cerraduras y módulo "hotel sin recepción nocturna"). Ninguna bloquea el
  ciclo de construcción local; todas están explícitamente fuera del mandato de un agente para
  decidirse solo.
- **Discrepancia de conteo del encargo**: el encargo de esta ronda indicaba 20 hallazgos; el
  documento de auditoría real tiene 19 (2 CRÍTICO + 7 ALTO + 6 MEDIO + 4 BAJO, no 7 MEDIO). Se
  documenta aquí en vez de fabricar un vigésimo hallazgo para cuadrar la cifra.

---

## Ronda 2 de corrección (vuelta 2/3) — respuesta a `docs/auditoria-0/reauditoria.md`

Agente de corrección (Sonnet), contexto fresco. Fuente única: `docs/auditoria-0/reauditoria.md`
(reauditor Sonnet, contexto fresco). Ese documento **no se modificó**. Se corrigieron los 3
hallazgos nuevos que el reauditor encontró (2 ALTO, 1 BAJO) y el hallazgo MEDIO #14 de la ronda 0,
que en la ronda 1 había quedado deliberadamente sin cerrar por vivir en un archivo de "extractos de
fuente" protegido — el orquestador autorizó explícitamente esta vuelta la corrección factual puntual
de esa página.

### Tabla de los 19 hallazgos originales + los 3 nuevos, estado final tras la vuelta 2

| # | Sev. | Título | Estado final | Commit(s) |
|---|---|---|---|---|
| 1 | CRÍTICO | GOB-025 sin citar/excluir | arreglado (sin cambios en vuelta 2) | `67421a3` |
| 2 | CRÍTICO | ADR-003 cambia proveedor de BD sin aprobación | arreglado (sin cambios en vuelta 2) | `8a45d7a` |
| 3 | ALTO | Conteo cabecera GOB no cuadra | arreglado (sin cambios en vuelta 2) | `35b0cf5` |
| 4 | ALTO | Tenencia contradictoria REQUISITOS/ARQUITECTURA | arreglado en ronda 1; el reauditor detectó que el mismo defecto de roles reaparecía en `ACEPTACION.md` (ver hallazgo nuevo #1) — cerrado de punta a punta en vuelta 2 | `42f21c1` (ronda 1) + `eb39620` (vuelta 2) |
| 5 | ALTO | Ningún doc posterior a REQUISITOS.md cita REQ-* | arreglado (sin cambios en vuelta 2) | `cb4d2e6` (+ `a87b353`, `0fe1e7c`, `afae6fc`) |
| 6 | ALTO | Matriz de roles ADR-004 ≠ REQ-TEN-003 | arreglado en ARQUITECTURA.md en ronda 1; el reauditor detectó la misma regresión en `ACEPTACION.md` (ver hallazgo nuevo #1) — cerrado de punta a punta en vuelta 2 | `afae6fc` (ronda 1) + `eb39620` (vuelta 2) |
| 7 | ALTO | Dominio Energía/IoT/HVAC/cerraduras sin ADR/hito | arreglado en ARQUITECTURA.md/ACEPTACION.md en ronda 1; el reauditor detectó que `RUBROS.md` (documento hermano) seguía sin ningún gancho al dominio (ver hallazgo nuevo #2) — cerrado en vuelta 2 | `a87b353` (ronda 1) + `ba82077` (vuelta 2) |
| 8 | ALTO | 10 contradicciones §4 no resueltas | arreglado (sin cambios en vuelta 2) | `0fe1e7c` |
| 9 | ALTO | 88 IDs sin citar | arreglado (sin cambios en vuelta 2) | `67421a3` |
| 10 | MEDIO | `hotel-staff-pwa` sin definir como PWA | arreglado (sin cambios en vuelta 2) | `bd59010` |
| 11 | MEDIO | Catálogo GOB-012 omite ítems de su fuente | arreglado (sin cambios en vuelta 2) | `109aa4e` |
| 12 | MEDIO | REQ-RES-001 cita fuente ajena | arreglado (sin cambios en vuelta 2) | `32b4fe8` |
| 13 | MEDIO | REQ-RES-022 sin calificador temporal | arreglado (sin cambios en vuelta 2) | `26cafa6` |
| 14 | MEDIO | Página H04-018 incorrecta (H04, p.14 → p.13) | **arreglado en vuelta 2** — corrección factual puntual autorizada explícitamente por el orquestador; el error vivía en `docs/referencia/02-investigacion-H01-H11.md:276` (no en `03-investigacion-H12-H21.md` como indicaba el encargo de esta vuelta — verificado por grep que el ID solo existe en `02-...md`); `REQUISITOS.md` no repite el número de página en sus citas a H04-018, no requirió cambio | `21b4aac` |
| 15 | MEDIO | Prioridad UX-003 inconsistente | arreglado (sin cambios en vuelta 2) | `4e7cfb9` |
| 16 | BAJO | REQ-HUE-001 funde dos SLA | arreglado (sin cambios en vuelta 2) | `699eb49` |
| 17 | BAJO | REQ-HUE-007 cita evals pre-release | arreglado (sin cambios en vuelta 2) | `782c14f` |
| 18 | BAJO | Celdas rotas tabla de hitos | arreglado (sin cambios en vuelta 2) | `17ed607` |
| 19 | BAJO | `docs/audits/...` no existe en este repo | arreglado (sin cambios en vuelta 2) | `42af2a9` |
| Nuevo 1 | ALTO | `ACEPTACION.md:27` exige 9 roles con `huesped` en `hotel_staff`, contradiciendo REQ-TEN-003/ADR-004 (8 roles) | **arreglado** — línea 27 y la prueba adversarial de escalada de rol (línea 407) alineadas al modelo de 8 roles; `superadmin`/`huesped` declarados explícitamente fuera del enum, igual que en ADR-004; verificado sin rastro del modelo de 9 roles (`grep -n "9 roles\|,huesped\`" docs/ACEPTACION.md` → sin salida) | `eb39620` |
| Nuevo 2 | ALTO | `docs/auditoria/RUBROS.md` sin ningún gancho al dominio energía/IoT/HVAC/cerraduras de ADR-011/H11 | **arreglado** — añadidos "qué cuenta", "dónde" y REQ-* de ancla (`REQ-BO-027/028/029`, `REQ-INT-007/008`, `REQ-RES-017`, `REQ-REC-009`, `REQ-SEG-015`) en los 5 rubros pertinentes (2 Backend/API, 4 Tool calling, 5 Seguridad, 10 Operabilidad, 12 Modelo de datos); línea 5 actualizada a "ADR-001..011" | `ba82077` |
| Nuevo 3 | BAJO | `docs/DECISIONS-HUMANAS.md` citado en REQUISITOS.md/BLOQUEOS.md como si fuera archivo local; no existe en este repo | **arreglado** — ambas citas aclaran ahora que es una referencia heredada a `DECISIONS-HUMANAS.pdf` (fuente externa, vía `docs/referencia/01-blueprint-y-decision-llm.md:370,396`) y apuntan a `docs/BLOQUEOS.md` D-002 como registro local equivalente; no se creó ningún archivo local ficticio (`ls docs/DECISIONS-HUMANAS.md` → no existe) | `871a973` |

**Resumen vuelta 2:** 4 hallazgos atendidos (1 MEDIO pendiente de ronda 1 + 3 nuevos del reauditor:
2 ALTO, 1 BAJO). Los 19 hallazgos originales quedan con estado final **arreglado** (18/19 ya lo
estaban desde ronda 1 sin necesitar cambio; #14 se cerró en esta vuelta). Los 2 hallazgos "cerrados
parcialmente" que el reauditor señaló (#4 y #6, regresión en `ACEPTACION.md`) quedan cerrados de
punta a punta con el commit del hallazgo nuevo #1.

### Notas por documento (del reauditor, ronda 2 — reemplazan la recalificación anterior)

- **`docs/REQUISITOS.md` — 9/10.** *Se atacó y subió* (de 7 a 9 en la ronda 1). Los tres defectos que
  bajaban la nota de 10 a 7 (conteo de cabecera GOB, 88 IDs sin ruta, GOB-025 específicamente) están
  verificados cerrados con script propio del reauditor, no con el comando pegado por el corrector. No
  sube a 10 porque solo se re-verificó una muestra (~15) de las 99 citas nuevas añadidas para rutear
  los 87 IDs restantes, no las 99 una por una, y porque heredaba una cita con página incorrecta en su
  fuente (H04-018) fuera de su control — corregida en esta vuelta 2 (`21b4aac`).
- **`docs/ARQUITECTURA.md` — 9/10.** *Se atacó y subió* (de 6 a 9). Los cinco defectos de coherencia
  que bajaban la nota (0 citas REQ-*, tenant=hotel, roles distintos a REQ-TEN-003, dominio energía sin
  ADR, contradicciones §4 sin resolver) están cerrados con evidencia verificada línea por línea. No
  sube a 10 por ser un documento de 71 KB con 11 ADR; no se releyó cada línea de ADR-005/008/009/010
  contra su fuente en la ronda de reauditoría, solo las secciones tocadas por los 19 hallazgos.
- **`docs/auditoria/RUBROS.md` — 7/10** (antes de esta vuelta 2). *Mirada más profunda reveló deuda
  nueva*: ganó "Requisitos-ancla (REQ-*)" verificado como real en los 12 rubros, cerrando su parte del
  hallazgo ALTO #7 compartido, pero el commit que creó ADR-011/H11 nunca volvió a tocar `RUBROS.md`
  (cero menciones de energía/IoT/HVAC/cerraduras/ADR-011 en todo el archivo). Corregido en esta vuelta
  2 (`ba82077`) — **pendiente que una ronda de reauditoría posterior verifique y recalifique** este
  arreglo; esta síntesis no se autocalifica.
- **`docs/auditoria/AUDITOR-PROMPT.md` — 8/10.** *Sin cambio neto.* Se corrigió `tenant=org` y se
  añadió una cita a REQ-TEN-002 en la ronda 1, consistente con el resto. No se detectó ni un defecto
  nuevo ni una mejora sustantiva adicional; el documento no reclama cobertura de rubros/dominios (eso
  lo delega a RUBROS.md), así que el hueco de energía/IoT no le aplicaba igual que a RUBROS.md. Sin
  cambios en esta vuelta 2.
- **`docs/BLOQUEOS.md` — 8/10.** *Se atacó y subió* (de 6 a 8 en la ronda 1). Los dos defectos de
  B-002 (cifra de vitest incorrecta, "decisión pendiente" cuando ya estaba tomada) están corregidos;
  D-001..D-004 exponen con el mismo formato claro las cuatro decisiones reales reservadas al fundador
  sin bloquear el ciclo local. No subía a 9-10 porque heredaba sin aclarar la cita a
  `docs/DECISIONS-HUMANAS.md` como si fuera local — corregido en esta vuelta 2 (`871a973`).
- **`docs/operacion-bucle.md` — 7/10.** *Sin cambio.* No fue objeto de ningún hallazgo de la ronda 0
  ni de la reauditoría; ningún commit lo tocó en ninguna vuelta. Releído íntegro por el reauditor sin
  encontrar afirmación nueva que contradiga el resto del corpus corregido ni mejora que justifique
  subir la nota.

### Verificación pegada (comandos + salida real)

```
$ grep -n "9 roles\|,huesped\`\|accountant,huesped" docs/ACEPTACION.md
(sin salida)

$ grep -c "energ\|IoT\|HVAC\|cerradura\|EnergyPort\|LockPort\|ADR-011" docs/auditoria/RUBROS.md
6

$ grep -rn "DECISIONS-HUMANAS.md" docs/REQUISITOS.md docs/BLOQUEOS.md
docs/REQUISITOS.md:417:...decisión #7 del catálogo externo `DECISIONS-HUMANAS.pdf`...
docs/BLOQUEOS.md:31:...decisión #7 del catálogo externo `DECISIONS-HUMANAS.pdf`...
$ ls docs/DECISIONS-HUMANAS.md
ls: docs/DECISIONS-HUMANAS.md: No such file or directory

$ grep -n "H04-018" docs/referencia/02-investigacion-H01-H11.md
276:| H04-018 | ... | H04, p.13 | ...
```

**Vuelta 2/3 cerrada; pendiente reauditoría de `RUBROS.md` tras el arreglo del hallazgo nuevo #2.**
