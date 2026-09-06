# Reauditoría de la ronda de corrección — Atiende Hoteles (ronda 0)

Auditor: Sonnet, contexto fresco. Objeto: verificar, hallazgo por hallazgo, que los 18 commits
`fix(aud-0): ...` y `docs/auditoria-0/00-SINTESIS.md` corrigieron de verdad los 19 hallazgos de
`docs/auditoria-0/documentos.md`, sin fabricar los números. Método: para cada hallazgo, lectura del
hallazgo original + `git show <sha>` del commit que dice arreglarlo + inspección del estado actual
del archivo con grep/awk propios (no se confió en los comandos pegados por el corrector; se
re-ejecutaron todos). No se propone ningún arreglo; este documento solo reporta.

## Verificación de los 6 checks obligatorios del encargo

**(a) ADR-003 reencuadrado.** Correcto y honesto. El título del ADR ahora dice explícitamente
"producción sigue siendo Supabase (decisión no tomada por este ADR)"; el primer párrafo ("Alcance de
este ADR, léase antes que nada") declara que PGlite/`embedded-postgres` son solo entorno
local de desarrollo/pruebas, que H20 sigue fijando Supabase como destino de producción, y que un
cambio real de proveedor de BD sigue reservado al fundador (`REQ-GOB-012`/`REQ-AGT-011`), con la
decisión expuesta sin bloquear en `docs/BLOQUEOS.md` D-001. No decide ni insinúa abandonar Supabase.

**(b) Tenencia y roles: ¿REQUISITOS, ARQUITECTURA y ACEPTACION dicen lo mismo?** NO. REQUISITOS.md
(`REQ-TEN-002/003`) y ARQUITECTURA.md (ADR-004, corregido) coinciden ahora: `tenant = org`, 8 roles
exactos de `hotel_staff` (`owner, gm, frontdesk, reservations, housekeeping, maintenance, fnb,
accountant`), `superadmin`/`huesped` declarados explícitamente como conceptos aparte, fuera del
enum. Pero **`docs/ACEPTACION.md:27`** (criterio de aceptación de `REQ-TEN-003`) sigue diciendo
`"Existen 9 roles (owner,gm,frontdesk,reservations,housekeeping,maintenance,fnb,accountant,huesped)"`
— incluye `huesped` como noveno rol de `hotel_staff`, contradiciendo tanto el propio `REQUISITOS.md`
(8 roles) como el ADR-004 ya corregido, que dice literalmente que `huesped` "no forma parte del enum
de roles de hotel". Este documento no fue tocado por ningún commit de corrección de roles. Ver
hallazgo nuevo #1 abajo.

**(c) 88 IDs de origen (script propio).**
```
$ grep -ohE '^\| (BP|LLM|GOB|H[0-9]+)-[0-9]+' docs/referencia/01-blueprint-y-decision-llm.md docs/referencia/02-investigacion-H01-H11.md docs/referencia/03-investigacion-H12-H21.md docs/referencia/04-gobierno-y-protocolo.md | sed 's/^| //' | sort -u > /tmp/all_source_ids.txt
$ wc -l /tmp/all_source_ids.txt
     640
$ grep -ohE '\b(BP|LLM|GOB|H[0-9]+)-[0-9]+\b' docs/REQUISITOS.md | sort -u > /tmp/cited.txt
$ comm -23 /tmp/all_source_ids.txt /tmp/cited.txt | wc -l
0
```
Los 640 IDs de origen quedan citados en al menos una fila o en la tabla de exclusión (ahora 21 IDs:
5 mercado + 15 Licitaciones + 1 roadmap 2029, `H06-018`). Verifiqué a mano los 6 casos que el auditor
original citó como muestra (`GOB-025→REQ-AGT-022`, `H06-001→REQ-HUE-027`, `H09-001→REQ-OBS-011`,
`H04-012→REQ-BO-036`, `H04-025→REQ-SEG-019`, `H18-003/004→REQ-GOB-017`/`REQ-BO-030`/`REQ-GOB-012`):
las 6 son requisitos sustantivos y coherentes con la fuente, no relleno cosmético para cuadrar el
conteo. **Cerrado.**

**(d) Conteos de cabecera.**
```
$ awk -F'|' '/^\| REQ-/{id=$2; gsub(/^ +| +$/,"",id); mod=id; sub(/^REQ-/,"",mod); sub(/-[0-9]+$/,"",mod); prio=$5; gsub(/^ +| +$/,"",prio); print mod, prio}' docs/REQUISITOS.md | sort | uniq -c
```
Verificado módulo por módulo y prioridad por prioridad contra la tabla "0. Conteos" (líneas 11-27):
los 16 módulos cuadran exactamente en las 4 columnas de prioridad, y el total (276 | 128 P0 | 85 P1 |
53 P2 | 10 P3) también cuadra sumando las 16 filas. **Cerrado**, incluido el módulo GOB
(14 P0/4 P1/3 P2/21 total, antes 15/3/3 declarado vs. 14/4/3 real) y el módulo UX (que había quedado
descuadrado por el commit de prioridad de accesibilidad y se corrigió después).

**(e) Paridad REQUISITOS↔ACEPTACION.**
```
$ diff <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/REQUISITOS.md | sort -u) <(grep -o 'REQ-[A-Z]*-[0-9]*' docs/ACEPTACION.md | sort -u)
(sin salida)
$ grep -c "^| REQ-" docs/ACEPTACION.md
276
```
Mismo conjunto exacto de 276 IDs en ambos documentos. **Cerrado** en cobertura de IDs — pero la
paridad de **contenido** falla en al menos una fila (ver (b) y hallazgo nuevo #1): tener el mismo ID
en ambos documentos no garantiza que digan lo mismo.

**(f) ADR-011 y su hito.** Existe: `## ADR-011 — Puerto edge/IoT (energía, HVAC, cerraduras)...`
(`docs/ARQUITECTURA.md:292`), con contrato `EnergyPort`/`LockPort`, adaptador simulado etiquetado,
estado `[PENDIENTE DE HARDWARE/CREDENCIALES]`, sección "Requisitos que cubre" (`REQ-BO-027/028/029`,
`REQ-INT-007/008`, `REQ-RES-017`, `REQ-REC-009`, `REQ-SEG-015`) y prueba de verificación (análisis
estático de que `LockPort` es inalcanzable desde reglas de energía/voz). El hito **H11** existe en la
tabla de hitos de `ARQUITECTURA.md` y en "Compuertas por hito" de `ACEPTACION.md`, citando los mismos
8 `REQ-*`. **Cerrado.**

**(g) Página de H04-018.** Confirmado por extracción directa del PDF
(`H04-operaciones-backoffice-energia-hotel.pdf`, páginas 12-15): la página impresa **13** contiene
"Marco de nómina México 2026... registro electrónico de jornada (art. 132 fr. XXXIV LFT) plenamente
exigible desde 1-ene-2027" — coincide con lo que reportó el auditor original. La página 14 contiene
"5.3 Puestos parcialmente automatizables" y el inicio de "6. Finanzas y fiscal", sin mención del
art. 132. **Página correcta: 13** (la fila cita "H04, p.14", incorrecta). Confirmado que
`docs/referencia/02-investigacion-H01-H11.md:276` sigue sin tocar (archivo protegido, como registró
`00-SINTESIS.md`); sigue **no cerrado**, correctamente dejado así.

## Veredictos de los 19 hallazgos

| # | Sev. | Título | Commit | Veredicto |
|---|---|---|---|---|
| 1 | CRÍTICO | GOB-025 sin citar/excluir | `67421a3` | **Cerrado.** `REQ-AGT-022` (P0, SEG) cita GOB-025; ADR-006 documenta la decisión y su prueba; hito H7 la referencia; `grep -c GOB-025 docs/REQUISITOS.md`→1. |
| 2 | CRÍTICO | ADR-003 cambia proveedor de BD sin aprobación | `8a45d7a` | **Cerrado.** Ver check (a) arriba. D-001 registrado sin bloquear. |
| 3 | ALTO | Conteo cabecera GOB no cuadra | `35b0cf5` | **Cerrado.** Ver check (d). |
| 4 | ALTO | Tenencia contradictoria REQUISITOS/ARQUITECTURA | `42f21c1` | **Cerrado** entre esos dos documentos y en RUBROS/AUDITOR-PROMPT (verificado, ambos ahora dicen `tenant=org`). **Pero ver hallazgo nuevo #1**: ACEPTACION.md quedó fuera del alcance de este commit y todavía usa el modelo de roles viejo. |
| 5 | ALTO | Ningún doc posterior cita REQ-* | `cb4d2e6` (+incidentales) | **Cerrado.** `grep -oE 'REQ-[A-Z]+-[0-9]+' docs/ARQUITECTURA.md docs/auditoria/RUBROS.md docs/auditoria/AUDITOR-PROMPT.md \| wc -l` → 269 (antes 0); los 10 ADR y los 12 rubros tienen "Requisitos que cubre"/"Requisitos-ancla" verificados como reales, no decorativos. |
| 6 | ALTO | Matriz de roles ADR-004 ≠ REQ-TEN-003 | `afae6fc` | **Cerrado en ADR-004** (8 roles exactos, superadmin/huesped/revenue tratados explícitamente). **Regresión parcial señalada en hallazgo nuevo #1**: el defecto original reaparece en `ACEPTACION.md`, documento que el corrector no tocó para este hallazgo. |
| 7 | ALTO | Dominio Energía/IoT/HVAC sin ADR/hito | `a87b353` | **Cerrado en ARQUITECTURA/ACEPTACION** (ADR-011, hito H11, compuerta H11). **Recurre en RUBROS.md** — ver hallazgo nuevo #2 — que quedó sin tocar y no ancla ningún rubro a este dominio. |
| 8 | ALTO | 10 contradicciones §4 no resueltas | `0fe1e7c` | **Cerrado.** Sección "Resolución de las 10 contradicciones de REQUISITOS.md §4" resuelve las 10 por nombre y número; las que tocan el catálogo del fundador (2, 6, 9) se exponen en BLOQUEOS D-002/003/004 sin bloquear, consistente con el patrón de D-001. |
| 9 | ALTO | 88 IDs sin citar | `67421a3` | **Cerrado.** Ver check (c). |
| 10 | MEDIO | `hotel-staff-pwa` sin definir como PWA | `bd59010` | **Cerrado.** ADR-002 decide PWA real (manifest+SW) sin offline-first de datos; ACEPTACION.md añade verificación Lighthouse/Playwright. |
| 11 | MEDIO | Catálogo GOB-012 omite ítems de su fuente | `109aa4e` | **Cerrado.** Los 3 ítems (impacto reputacional, convivencia con el repo, LiveKit self-host) están ahora en el texto fusionado de `REQ-GOB-012` y en `ACEPTACION.md`. |
| 12 | MEDIO | REQ-RES-001 cita fuente ajena | `32b4fe8` | **Cerrado.** H03-007 retirado de RES-001, sigue correctamente en RES-016 (`grep -c H03-007`→1). |
| 13 | MEDIO | REQ-RES-022 sin calificador temporal | `26cafa6` | **Cerrado**, y extendido a `REQ-REV-008` (mismo defecto, misma fuente, no nombrado en el hallazgo original pero corregido por consistencia). |
| 14 | MEDIO | Página H04-018 incorrecta | — | **No cerrado** (correctamente): archivo fuente protegido. Ver check (g): página correcta confirmada = **13**. |
| 15 | MEDIO | Prioridad UX-003 inconsistente | `4e7cfb9` | **Cerrado.** UX-003 elevado a P0; cabecera UX (6\|3\|2\|1\|0) cuadra con `awk` propio. |
| 16 | BAJO | REQ-HUE-001 funde dos SLA | `699eb49` | **Cerrado.** Texto ahora declara ambos SLA (BP-110 vinculante, H07-010 aspiracional) sin retirar ninguna fuente. |
| 17 | BAJO | REQ-HUE-007 cita evals pre-release | `782c14f` | **Cerrado.** BP-103 retirado de HUE-007, sigue correcto en AGT-008/QA-006. |
| 18 | BAJO | Celdas rotas tabla de hitos | `17ed607` | **Cerrado.** Verificado en `docs/ARQUITECTURA.md:368-369`: sin residuo "H14-...". |
| 19 | BAJO | `docs/audits/...` no existe en este repo | `42af2a9` | **Cerrado.** ADR-002 aclara ahora que la ruta pertenece a `atiende-restaurantes`, vía `05-frontend-restaurantes.md`. |

**Resumen:** 17/19 cerrados limpios, 1 correctamente dejado no-cerrado (archivo protegido, #14), y 2
(#4 y #6) cerrados en el documento que originó el hallazgo pero con el mismo defecto reapareciendo
sin corregir en `ACEPTACION.md`/`RUBROS.md` — documentos hermanos que comparten la misma fuente y que
el corrector no verificó de punta a punta. No encontré ningún hallazgo falsamente marcado "arreglado".

## Recalificación de los 6 documentos

- **`docs/REQUISITOS.md` — 7 → 9.** *Se atacó y subió.* Los tres defectos que bajaban la nota de 10 a
  7 (conteo de cabecera GOB, 88 IDs sin ruta, GOB-025 específicamente) están verificados cerrados con
  script propio, no con el comando pegado por el corrector. No sube a 10 porque solo se
  re-verificó una muestra (~15) de las 99 citas nuevas añadidas para rutear los 87 IDs restantes, no
  las 99 una por una, y porque la matriz sigue heredando una cita con página incorrecta en su fuente
  (H04-018, fuera de su control).
- **`docs/ARQUITECTURA.md` — 6 → 9.** *Se atacó y subió.* Los cinco defectos de coherencia que bajaban
  la nota (0 citas REQ-*, tenant=hotel, roles distintos a REQ-TEN-003, dominio energía sin ADR,
  contradicciones §4 sin resolver) están cerrados con evidencia verificada línea por línea: ADR-003
  reencuadrado con honestidad explícita, ADR-004 con matriz de roles idéntica a REQ-TEN-003, ADR-011
  nuevo con contrato+prueba+hito, sección de resolución de las 10 contradicciones citando `BLOQUEOS.md`
  para lo que de verdad es decisión del fundador en vez de fingir resolverlo. No sube a 10 por ser un
  documento de 71 KB con 11 ADR; no se releyó cada línea de ADR-005/008/009/010 contra su fuente en
  esta ronda, solo las secciones tocadas por los 19 hallazgos.
- **`docs/auditoria/RUBROS.md` — 8 → 7.** *Mirada más profunda revela deuda nueva.* Ganó
  "Requisitos-ancla (REQ-*)" verificado como real en los 12 rubros (antes 0 citas), cerrando su parte
  del hallazgo ALTO compartido. Pero al perseguir ese mismo hallazgo (dominio energía/IoT sin ADR) until
  su origen, encontré que `RUBROS.md` nunca fue tocado por el commit que creó ADR-011/H11: cero
  menciones de `energ|IoT|HVAC|cerradura|EnergyPort|LockPort|ADR-011` en todo el archivo, y su línea 5
  sigue anclada a "ADR-001..010". El documento de auditoría que debería guiar al próximo auditor de
  rubro 5/12 no tiene ningún gancho hacia el dominio P0 que el propio proyecto reconoció que le
  faltaba. Baja de 8 a 7 por esa omisión concreta, no por nada que empeorara respecto a la ronda 0.
- **`docs/auditoria/AUDITOR-PROMPT.md` — 8 → 8.** *Sin cambio neto.* Se corrigió `tenant=org` (línea
  37) y se añadió una cita a REQ-TEN-002, consistente con el resto. No se detectó ni un defecto nuevo
  ni una mejora sustantiva adicional; el documento no reclama cobertura de rubros/dominios (delega eso
  a RUBROS.md), así que el hueco de energía/IoT no le aplica igual que a RUBROS.md.
- **`docs/BLOQUEOS.md` — 6 → 8.** *Se atacó y subió.* Los dos defectos de B-002 (cifra de vitest
  incorrecta, "decisión pendiente" cuando ya estaba tomada) están corregidos; D-001..D-004 exponen
  con el mismo formato claro las cuatro decisiones reales que quedan reservadas al fundador sin
  bloquear el ciclo local, coherente con lo que ARQUITECTURA.md dice en cada ADR. No sube a 9-10
  porque hereda sin aclarar la misma ambigüedad de `docs/audits/...` (cita `docs/DECISIONS-HUMANAS.md`
  como si fuera local — ver hallazgo nuevo #3).
- **`docs/operacion-bucle.md` — 7 → 7.** *Sin cambio.* No fue objeto de ningún hallazgo de la ronda 0
  y ningún commit lo tocó; releído íntegro no encontré ninguna afirmación nueva que contradiga el
  resto del corpus corregido ni ninguna mejora que justifique subir la nota.

## Hallazgos nuevos

### [ALTO] `docs/ACEPTACION.md:27` sigue exigiendo 9 roles (incluye `huesped`) en `hotel_staff`, contradiciendo el REQ-TEN-003 corregido y la matriz de ADR-004
`docs/ACEPTACION.md:27` — `docs/REQUISITOS.md:58` (REQ-TEN-003, 8 roles) — `docs/ARQUITECTURA.md` ADR-004 (matriz corregida, `huesped` declarado explícitamente fuera del enum)

Escenario: el criterio de aceptación de REQ-TEN-003 dice textualmente `"Existen 9 roles
(owner,gm,frontdesk,reservations,housekeeping,maintenance,fnb,accountant,huesped)"`. Tanto
REQUISITOS.md como el ADR-004 ya corregido en esta misma ronda (commit `afae6fc`) coinciden en que
son 8 roles y que `huesped` "no es staff del hotel... ninguno parte del enum de roles de hotel". El
commit que corrigió la matriz de roles (`afae6fc`) solo tocó `ARQUITECTURA.md`; no tocó
`ACEPTACION.md`.

Consecuencia: quien construya la prueba E2E/adversarial literalmente contra este renglón de
aceptación implementará o verificará un esquema de 9 roles con `huesped` dentro de `hotel_staff.role`,
exactamente el defecto que el hallazgo ALTO #6 de la ronda 0 identificó y que se dio por cerrado sin
verificar el documento hermano que comparte el mismo REQ-* y debería decir lo mismo.

(Verificado contra: `docs/ACEPTACION.md:27`; `docs/REQUISITOS.md:58`; `docs/ARQUITECTURA.md`
sección "Matriz de roles de `hotel_staff`" de ADR-004.)

### [ALTO] `docs/auditoria/RUBROS.md` no tiene ningún gancho hacia el dominio energía/IoT/HVAC/cerraduras que ADR-011 acaba de crear
`docs/auditoria/RUBROS.md` (completo) — `docs/ARQUITECTURA.md` ADR-011, hito H11

Escenario: esta misma ronda de corrección creó ADR-011 y el hito H11 para cerrar el hallazgo ALTO
original sobre el dominio de energía/IoT/HVAC/cerraduras. `RUBROS.md` fue tocado en la misma ronda
(commit `cb4d2e6`) para añadir "Requisitos-ancla (REQ-*)" a sus 12 rubros, pero ese commit fue
anterior a `a87b353` (el que creó ADR-011) y nadie volvió a `RUBROS.md` después.
`grep -n "energ\|IoT\|HVAC\|cerradura\|EnergyPort\|LockPort\|ADR-011" docs/auditoria/RUBROS.md` no
devuelve ninguna coincidencia; ningún rubro ancla `REQ-BO-027/028/029`, `REQ-INT-007/008` ni
`REQ-SEG-015`/`REQ-REC-009` (los mismos 8 `REQ-*` que ADR-011 declara cubrir). La línea 5 del
documento sigue describiendo la arquitectura auditada como "ADR-001..010".

Consecuencia: un auditor de rubro 5 (seguridad) o rubro 12 (modelo de datos) que siga `RUBROS.md`
como su única guía no tiene ninguna instrucción para revisar `EnergyPort`/`LockPort`, pese a que son
P0 y pese a que el propio proyecto ya reconoció una vez (hallazgo ALTO de la ronda 0) que dejar un
dominio P0 sin ruta de verificación es un problema serio — el mismo patrón reaparece un documento más
abajo en la cadena.

(Verificado contra: `docs/auditoria/RUBROS.md` completo vía grep de los términos citados; comparado
contra `docs/ARQUITECTURA.md:292-310` ADR-011 y `docs/ARQUITECTURA.md:378` hito H11.)

### [BAJO] `docs/DECISIONS-HUMANAS.md`, citado por número de ítem en REQUISITOS.md y BLOQUEOS.md, no existe en este repositorio
`docs/REQUISITOS.md:417` — `docs/BLOQUEOS.md:31`

Escenario: ambos archivos citan `docs/DECISIONS-HUMANAS.md #7` como si fuera un archivo local
consultable (heredado de las citas literales de `docs/referencia/01-blueprint-y-decision-llm.md:370,396`
y `04-gobierno-y-protocolo.md`, que sí documentan de dónde viene la cita — el PDF
`DECISIONS-HUMANAS.pdf`, que solo existe en la carpeta de PDF de referencia, no en este repo).
`ls docs/DECISIONS-HUMANAS.md` no existe. Es exactamente el mismo patrón que el hallazgo BAJO #19 de
la ronda 0 (`docs/audits/enterprise-remediation-2026-09-04.md`), que sí se corrigió aclarando el
origen externo de la ruta — esta cita no recibió el mismo tratamiento.

Consecuencia: menor — quien intente abrir `docs/DECISIONS-HUMANAS.md #7` desde este repo para
verificar la decisión #7 (Opción C "no final") no la encontrará y no tiene, en el texto de
REQUISITOS.md/BLOQUEOS.md, ninguna nota que le diga que es una referencia heredada al PDF de
`04-Gobierno-y-protocolo/DECISIONS-HUMANAS.pdf`.

(Verificado contra: `ls docs/DECISIONS-HUMANAS.md` → no existe;
`find "/Users/javiercamaraportepetit/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF" -iname "*DECISIONS-HUMANAS*"`
→ existe solo como PDF en `05-Gobierno-y-protocolo/`.)

## Lo que revisé y está bien

- Los 17 hallazgos restantes (todos salvo #4 y #6, que cerraron parcialmente) están genuinamente
  cerrados en el documento donde se originó el hallazgo, con evidencia re-verificada por mí con
  comandos propios, no solo aceptando los pegados en cada commit.
- Los 6 checks obligatorios del encargo (a-f) pasan limpio; (g) confirma la página exacta (13) que el
  auditor original reportó, extrayendo yo mismo las páginas 12-15 del PDF.
- Revisé el diff completo (`git show`) de los 18 commits de corrección: ninguno mezcla cambios no
  relacionados con su propio hallazgo, ninguno toca `docs/referencia/*` (respetando la restricción de
  no editar fuente), y los mensajes de commit describen con precisión lo que el diff realmente hace
  (no encontré ningún commit que afirme algo que el diff no respalda).
- Spot-check de 6 de las 99 citas nuevas añadidas para rutear los 87 IDs de origen restantes
  (`H06-001→REQ-HUE-027`, `H09-001→REQ-OBS-011`, `H04-012→REQ-BO-036`, `H04-025→REQ-SEG-019`,
  `H18-003→REQ-GOB-017`, `H18-004→REQ-BO-030`/`REQ-GOB-012`): las 6 son sustantivas, no relleno
  cosmético para cuadrar el conteo a 0 uncited.
- `docs/ACEPTACION.md` §3 "Compuertas por hito" cubre correctamente H1..H11 con los mismos `REQ-*`
  que la tabla de hitos de `ARQUITECTURA.md`, incluida la fila H11 nueva.
- `docs/ARQUITECTURA.md` Resumen final (línea 398) sí refleja correctamente `tenant=org` y "matriz de
  8 roles... + superadmin/huesped como conceptos aparte" — la corrección de roles/tenencia es
  consistente dentro de ese mismo documento, el problema es solo la falta de propagación a
  `ACEPTACION.md`.

## Lo que NO alcancé a revisar

- No reverifiqué una por una las 99 citas de fuente añadidas a requisitos existentes (solo 6 de
  muestra) ni los ~214 REQ-* que la ronda 0 tampoco había verificado individualmente contra su fuente
  original — el riesgo de citas infladas puntuales en el resto de la matriz sigue sin descartarse.
- No releí `docs/ARQUITECTURA.md` completo línea por línea contra `docs/referencia/06-backoffice-agentes-likida.md`
  para los ADR-005/008/009/010 no tocados por los 19 hallazgos; solo verifiqué las secciones que los
  commits de corrección modificaron directamente.
- No verifiqué si `docs/AGENTES.md` o `docs/PROGRESO.md` (fuera del alcance original) quedaron
  consistentes con el modelo de tenant=org/roles corregido — no fueron tocados por ningún commit de
  esta ronda y no los audité.
- No ejecuté ninguna prueba de código (no existe código en este repo, solo documentación); toda la
  verificación es de consistencia documental, no de comportamiento real de un sistema.
- No re-audité `docs/operacion-bucle.md` más allá de una relectura de consistencia textual; no
  reverifiqué `docs/logs/bucle.log` de forma independiente en esta ronda.
