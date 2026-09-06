# Auditoría adversarial de documentos — Atiende Hoteles (ronda 0)

Auditor: Sonnet, contexto fresco (consolidado a partir de verificación directa propia más cuatro
subagentes Sonnet de contexto fresco, cada uno cubriendo una partición de módulos/documentos).
Objeto: `docs/REQUISITOS.md`, `docs/ARQUITECTURA.md`, `docs/auditoria/RUBROS.md`,
`docs/auditoria/AUDITOR-PROMPT.md`, `docs/BLOQUEOS.md`, `docs/operacion-bucle.md`. Fuentes de
verdad: `docs/referencia/01..07` completos y PDF original en
`/Users/javiercamaraportepetit/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF/` (verificado
con `pages` acotado para una muestra de citas). Muestra de trazabilidad cubierta: ~56 REQ-*
verificados uno a uno contra su fuente citada (repartidos entre los 16 módulos y las cuatro
prioridades), 13 de ellos confirmados además contra la página exacta del PDF original.
No se propone ningún arreglo; este documento solo reporta.

## Notas por documento

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

## Hallazgos

### [CRÍTICO] GOB-025 (aislamiento de contexto entre tenants en los prompts) no está citado ni excluido
`docs/REQUISITOS.md:38` y `:40-47` (§1–§2) — `docs/referencia/04-gobierno-y-protocolo.md:46`

Escenario: `docs/REQUISITOS.md:38` afirma "no se descartó ningún ID origen salvo los listados" en
§2, y §2 declara una lista cerrada de exactamente 20 IDs excluidos (5 de mercado + 15 de gobierno
de Licitaciones), cada uno con razón escrita. `GOB-025` — "el contexto de un agente solo incluye
datos del tenant en curso y hechos públicos; prohibido few-shot con propuestas de otros tenants...
`trace_include_sensitive_data=False` y redacción de PII antes de cualquier traza"
(`docs/referencia/04-gobierno-y-protocolo.md:46`) — no es un ID de mercado ni específico de
Licitaciones (las dos únicas categorías que el §2 admite como motivo de exclusión), y no aparece
citado en ninguna fila de `REQUISITOS.md` (`grep -c "GOB-025" docs/REQUISITOS.md` → 0) ni en la
tabla de exclusión. La redacción de PII en trazas queda cubierta indirectamente por otro ID
(GOB-035 → REQ-AGT-006), pero el aislamiento de **contexto/prompt** entre hoteles —distinto de la
RLS a nivel de base de datos que sí cubren REQ-TEN-001/GOB-038— no tiene ningún requisito canónico
propio.

Consecuencia: `docs/auditoria/RUBROS.md:71` define explícitamente que la fuga de datos entre
hoteles a nivel de contexto de conversación es "el eje propio de este producto frente a Likida".
La única regla de gobierno que exige impedir exactamente eso a nivel de prompt del agente quedó
fuera de la matriz que se supone que traza cada regla a un requisito verificable; un futuro
auditor del rubro 5 (seguridad/aislamiento) no tiene contra qué `REQ-*` contrastar ese control.

(Verificado contra: `docs/referencia/04-gobierno-y-protocolo.md:46`; comando
`grep -c "GOB-025" docs/REQUISITOS.md` → `0`, confirmado además que GOB-025 no aparece en la tabla
de exclusión de `docs/REQUISITOS.md:44-45`.)

### [CRÍTICO] ADR-003 decide un cambio de proveedor de base de datos sin la aprobación del fundador que el propio catálogo de gobierno exige
`docs/ARQUITECTURA.md:59-76` (ADR-003) — `docs/REQUISITOS.md:390` (REQ-GOB-012), `docs/REQUISITOS.md:279`
(REQ-AGT-011) — `docs/referencia/04-gobierno-y-protocolo.md:72` (GOB-051), `docs/referencia/01-blueprint-y-decision-llm.md:370` (LLM-022)

Escenario: H20 fija "Supabase multi-tenant" (Postgres cloud gestionado con RLS+GoTrue+PostgREST)
como plataforma de datos (`docs/referencia/03-investigacion-H12-H21.md:151`). `REQ-GOB-012` (P0,
`docs/REQUISITOS.md:390`) y `REQ-AGT-011` (`docs/REQUISITOS.md:279`) —ambos derivados de GOB-051 y
LLM-022 respectivamente— fijan como catálogo cerrado que "cualquier cambio de proveedor de
modelo/telefonía/BD... requiere decisión reservada al fundador" y que ese cambio "requiere
aprobación explícita registrada... antes de mergear/ejecutar". `ADR-003` decide abandonar la capa
gestionada de Supabase (GoTrue/PostgREST/Postgres cloud) por un Postgres propio (PGlite +
`embedded-postgres`) citando únicamente restricciones técnicas del entorno (`docs/BLOQUEOS.md`
B-002: Docker/Supabase CLI no funcionan) — sin invocar el mecanismo `needs-human` que
`REQ-GOB-006`/GOB-045 exigen para cualquier tarea que toque el catálogo de decisiones reservadas, y
sin registrar ninguna aprobación del fundador en `docs/BLOQUEOS.md`, `docs/PROGRESO.md` ni en el
propio ADR.

Consecuencia: el mismo tipo de agente que se beneficiaría de saltarse una aprobación por
conveniencia técnica (evitar instalar Docker) es quien decide unilateralmente saltársela; sienta un
precedente de que "restricción de entorno" basta para resolver una decisión que el propio proyecto
declaró como exclusiva del fundador humano, exactamente la categoría de decisión (proveedor de
BD/modelo/telefonía) que el catálogo trata con más severidad porque sostiene el resto de las
garantías de aislamiento multi-tenant del producto.

(Verificado contra: `docs/REQUISITOS.md:279,390`; `docs/referencia/04-gobierno-y-protocolo.md:72`;
`docs/referencia/01-blueprint-y-decision-llm.md:370`; `docs/BLOQUEOS.md:16-19`; ausencia de mención
de aprobación del fundador en `docs/ARQUITECTURA.md:59-76` y en `docs/BLOQUEOS.md`/`docs/PROGRESO.md`.)

### [ALTO] El conteo de cabecera del módulo GOB no cuadra con sus propias filas
`docs/REQUISITOS.md:26` (tabla "0. Conteos") vs. `docs/REQUISITOS.md:379-399` (filas reales GOB-001..021)

Escenario: la tabla de conteos declara `GOB | 21 | 15 | 3 | 3 | 0` (15 P0, 3 P1, 3 P2). Contando
las 21 filas reales de la sección 3.16 con
`awk -F'|' '/^\| REQ-GOB-/{print $5}' docs/REQUISITOS.md | sort | uniq -c` el resultado es **14
P0** (GOB-001 a 007, 009 a 013, 016, 019), **4 P1** (GOB-008, 014, 020, 021), 3 P2 — el total de la
fila (21) cuadra, el desglose por prioridad no. El mismo error se arrastra al total general de la
tabla: declara 127 P0/84 P1 cuando la suma real de las 270 filas da **126 P0/85 P1**
(`awk -F'|' '/^\| REQ-/{...}' docs/REQUISITOS.md | sort | uniq -c` sobre las 16 columnas de
prioridad, sumado por módulo). Los otros 15 módulos sí cuadran exactamente.

Consecuencia: el propio documento presenta esta tabla en su título como "cuenta real sobre este
documento"; cualquier reporte de avance que la use como línea base ("quedan 127 P0 por cerrar", "X
de 15 P0 de GOB completados") parte de un número que el propio archivo contradice.

(Verificado contra: comando reproducible
`awk -F'|' '/^\| REQ-/{id=$2; gsub(/^ +| +$/,"",id); mod=id; sub(/^REQ-/,"",mod); sub(/-[0-9]+$/,"",mod); prio=$5; gsub(/^ +| +$/,"",prio); print mod, prio}' docs/REQUISITOS.md | sort | uniq -c`
ejecutado sobre el propio `docs/REQUISITOS.md`, sin fuente externa necesaria.)

### [ALTO] Modelo de tenencia contradictorio entre REQUISITOS.md y ARQUITECTURA.md, citando la misma fuente
`docs/REQUISITOS.md:56` (REQ-TEN-002) vs. `docs/ARQUITECTURA.md:88` (ADR-004) — `docs/referencia/03-investigacion-H12-H21.md:134,151` (H20)

Escenario: REQ-TEN-002 dice "cada hotel como una `location` con `kind='hotel'` bajo una `org`
**(tenant)**" — es decir, el tenant es la `org`. ADR-004 dice literalmente "`tenant = hotel`, con un
nivel superior opcional `org` (grupo hotelero)" — el tenant es el `hotel`, no la `org` — y cita como
respaldo la misma fuente H20 ("igual que H20 exige, `org → location`..."). La fuente real
(`docs/referencia/03-investigacion-H12-H21.md:151`) dice "Multi-tenant sobre Postgres/Supabase con
RLS (`org → location`)" — consistente con la lectura de REQUISITOS.md (org es el límite del
tenant), no con la de ADR-004. `RUBROS.md:5` y `AUDITOR-PROMPT.md:37` adoptan la lectura de
ADR-004 ("tenant_id = hotel") sin señalar el conflicto con REQUISITOS.md.

Consecuencia: la RLS, el modelo de permisos y la definición misma de "fuga entre tenants" —el eje
de seguridad central del producto según el propio `RUBROS.md`— dependen de cuál es el límite de
aislamiento; dos de los cuatro documentos auditados (`ARQUITECTURA.md`, y por herencia `RUBROS.md`/
`AUDITOR-PROMPT.md`) usan un límite distinto al que define el único requisito canónico que fija el
modelo de datos (`REQ-TEN-002`), sin que ninguno declare la divergencia como una decisión
consciente.

(Verificado contra: `docs/REQUISITOS.md:56`; `docs/ARQUITECTURA.md:88`;
`docs/referencia/03-investigacion-H12-H21.md:134,151`; `docs/auditoria/RUBROS.md:5`;
`docs/auditoria/AUDITOR-PROMPT.md:37`.)

### [ALTO] Ningún documento posterior a REQUISITOS.md cita un solo REQ-* canónico
`docs/ARQUITECTURA.md`, `docs/auditoria/RUBROS.md`, `docs/auditoria/AUDITOR-PROMPT.md` (los tres completos)

Escenario: `grep -oE 'REQ-[A-Z]+-[0-9]+' docs/ARQUITECTURA.md docs/auditoria/RUBROS.md docs/auditoria/AUDITOR-PROMPT.md | wc -l`
devuelve **0** en los tres archivos. La tabla "Hitos de implementación" de `ARQUITECTURA.md`
(líneas 291-304) tiene una columna explícita "Requisitos P0/gobierno cubiertos" para cada uno de
los 10 hitos, pero solo lista IDs de fuente (BP-/H-/GOB-), nunca el ID canónico de
`docs/REQUISITOS.md` que ese mismo proyecto define como "matriz de requisitos trazable". Lo mismo
ocurre en `RUBROS.md`/`AUDITOR-PROMPT.md`, que describen qué debe auditarse por tema pero nunca
enlazan un rubro a los `REQ-*` que cubre.

Consecuencia: la trazabilidad declarada en `docs/REQUISITOS.md` corre en una sola dirección
(fuente → REQ). Nada aguas abajo permite responder "¿qué hito construye REQ-SEG-014?" o "¿qué
rubro de auditoría verifica REQ-REC-003?" sin repetir manualmente el trabajo de correlación que
esta misma auditoría tuvo que hacer a mano. Rompe la utilidad práctica de la matriz para el resto
del ciclo de vida del proyecto (planeación, auditoría, cierre de fase).

(Verificado contra: `grep -oE 'REQ-[A-Z]+-[0-9]+' docs/ARQUITECTURA.md docs/auditoria/RUBROS.md docs/auditoria/AUDITOR-PROMPT.md | wc -l` → `0`.)

### [ALTO] La matriz de roles de ADR-004 no coincide con los roles exigidos por REQ-TEN-003 (misma fuente citada)
`docs/ARQUITECTURA.md:90-102` vs. `docs/REQUISITOS.md:57` — `docs/referencia/01-blueprint-y-decision-llm.md:242` (BP-109)

Escenario: REQ-TEN-003 (fuente BP-109) exige roles "owner, gm, frontdesk, reservations,
housekeeping, maintenance, fnb, accountant" (8 roles). La "Matriz mínima de roles" de ADR-004
define: `superadmin, gerente (GM), recepcion, housekeeping, mantenimiento, ayb, revenue,
contabilidad, huesped` (9 roles). No hay un rol equivalente a "owner" (dueño de un solo hotel;
`superadmin` es un rol de plataforma cross-tenant, un concepto distinto) ni a "reservations" como
rol separado (queda fusionado en `recepcion` sin decirlo); a cambio ADR-004 agrega `superadmin`,
`revenue` y `huesped`, ninguno presente en BP-109, sin citar una fuente para esa adición ni
declarar la divergencia.

Consecuencia: quien implemente `hotel_staff`/RLS a partir de ADR-004 construirá una matriz de
permisos distinta de la que describe el requisito trazable y su fuente; una prueba pgTAP escrita
contra REQ-TEN-003 buscando los roles "owner"/"reservations" no los encontrará en el esquema real,
y no queda definido quién, en el esquema de ADR-004, cumple el rol de "dueño de un hotel individual"
que varios otros requisitos mencionan (p. ej. REQ-UX-004, "panel del dueño/gerente").

(Verificado contra: `docs/ARQUITECTURA.md:90-102`; `docs/REQUISITOS.md:57`;
`docs/referencia/01-blueprint-y-decision-llm.md:242`.)

### [ALTO] Dominio Energía/IoT/HVAC/cerraduras sin ningún ADR, puerto ni hito, pese a tener 5+ requisitos P0
`docs/ARQUITECTURA.md:176-184` (tabla de integraciones ADR-007) y `:291-304` (tabla de hitos H1-H10) — `docs/REQUISITOS.md:255-257,301,329`

Escenario: `REQUISITOS.md` fija como P0 la lectura de telemetría de energía (REQ-BO-027, línea
255), el control de HVAC por estado del PMS (REQ-BO-028, línea 256), la ejecución local de reglas
de seguridad de energía con prioridad de huésped (REQ-BO-029, línea 257), la integración
obligatoria de hardware IoT de energía/edge (REQ-INT-007, línea 301, "como edge obligatorio") y que
las cerraduras nunca se gestionen por reglas automáticas (REQ-SEG-015, línea 329). La tabla de
integraciones de ADR-007 (líneas 176-184) solo lista PMS, WhatsApp, Pagos, CFDI, Voz y Correo —
ningún `EnergyPort`/`LockPort`, ninguna fila para Home Assistant/Shelly/Seam. La tabla de hitos
H1-H10 (líneas 291-304) tampoco asigna ningún hito a energía/edge/cerraduras: H6 cubre
housekeeping/mantenimiento + WhatsApp + `agent-core`; H9 cubre "adaptadores reales de integración
(PMS/WhatsApp/pagos/CFDI/voz)" sin mencionar energía ni cerraduras. La única mención de "Home
Assistant" en todo el archivo (línea 316, desvío #7) explica por qué no hay sincronización
offline-first de PowerSync, no por qué falta el puerto de energía en sí.

Consecuencia: un lector que use `ARQUITECTURA.md` para planear la construcción no encuentra ningún
ADR que decida el contrato/adaptador de energía o cerraduras, ni un hito que lo agende — a
diferencia de PMS/WhatsApp/pagos/CFDI/voz, que sí tienen puerto+adaptador+estado declarado, un
dominio entero con requisitos P0 (incluida la restricción de seguridad física REQ-SEG-015) queda
sin ruta de implementación documentada.

(Verificado contra: `docs/REQUISITOS.md:255-257,301,329,427`; `docs/ARQUITECTURA.md` completo vía
grep de "energ|iot|home assistant|shelly|seam|cerradura|hvac" → 3 coincidencias, ninguna en ADR-007
ni en la tabla de hitos.)

### [ALTO] Las 10 contradicciones que REQUISITOS.md delega explícitamente a ARQUITECTURA.md para resolver "antes de construir el módulo afectado" no se resuelven por nombre en ninguna
`docs/REQUISITOS.md:401-414` (§4, los 10 puntos) — `docs/ARQUITECTURA.md` (ausente)

Escenario: `docs/REQUISITOS.md:403` establece la regla: estas contradicciones "quedan documentadas
para el documento de arquitectura..., que deberá decidir cada una explícitamente antes de construir
el módulo afectado". `grep -in "contradicci|sección 4|§4\b" docs/ARQUITECTURA.md` no devuelve
ninguna referencia a esta sección ni a sus 10 puntos. El caso más concreto: la contradicción #2
(línea 406, "H20-001 fija Supabase... mientras BP-018/BP-116/BP-160/REQ-REC-013 exigen un 'modo
huracán/degradado de 72h' con copia local cifrada... no explican cómo el edge local reconcilia esa
copia cifrada con Supabase al reconectar") no tiene ninguna mención de "huracán", "degradado" ni
"72h" en ningún ADR de `ARQUITECTURA.md` (la única sincronización de edge que discute, línea 316,
es sobre PowerSync para IoT de energía, un módulo distinto). Las contradicciones #3 (tipo de
cambio), #4 (cifra de ROI), #6 (Decisión LLM no final), #9 (cerraduras vs. hotel sin recepción
nocturna) y #10 (OCR chino vs. postura occidental) tampoco tienen una decisión explícita
correspondiente en ningún ADR.

Consecuencia: REQ-REC-013 (P1, "modo huracán/degradado de 72h") y los demás módulos afectados
quedan sin la decisión de arquitectura que el propio proceso de este proyecto exigió cerrar antes
de construir — el vacío que `REQUISITOS.md` pidió resolver sigue abierto y sin registro de que se
haya considerado siquiera.

(Verificado contra: `docs/REQUISITOS.md:401-414` completo y `docs/ARQUITECTURA.md` completo vía
grep de los términos citados y de "contradicci"/"§4".)

### [ALTO] 88 IDs de origen (13.8% de ≈640) no están citados en ninguna fila ni en la tabla de exclusión, pese a declararse solo 20 excluidos
`docs/REQUISITOS.md:33,40-47` (§0/§2) — catálogo completo de IDs en `docs/referencia/01-04`

Escenario: además de `GOB-025` (ya reportado como CRÍTICO), otros 87 IDs de origen definidos en
`docs/referencia/01-04` no aparecen citados en ninguna fila de `REQUISITOS.md` ni en la tabla de
exclusión de §2 (verificado extrayendo los 640 IDs definidos en las 4 fuentes con
`grep -oE '^\| (BP|LLM|GOB|H[0-9]+)-[0-9]+' docs/referencia/0{1,2,3,4}-*.md` y comparando contra los
citados en `docs/REQUISITOS.md`). Una muestra inspeccionada manualmente confirma que no todos son
narrativa de mercado descartable: `H06-001` ("completar cotización, reserva, pago y facturación en
un solo hilo de WhatsApp sin cambiar de canal", `docs/referencia/02-investigacion-H01-H11.md:396`)
y `H09-001` (medir "alcanzabilidad" del canal vía estado del `wa_id` por reserva,
`docs/referencia/02-investigacion-H01-H11.md:631`) son funcionalidad de producto concreta, con
criterio de aceptación propio, ausente de cualquier `REQ-*`; `H04-012` (dimensionamiento de
instalación solar fotovoltaica) y `H04-025` (analítica de video sobre CCTV existente para
intrusión/conteo) tampoco tienen ningún requisito que las cubra ni aparecen mencionadas en el resto
del documento.

Consecuencia: el documento subestima en la práctica cuántos requisitos de origen quedaron fuera de
alcance sin decisión explícita — contradice directamente su propia afirmación de línea 38 ("no se
descartó ningún ID origen salvo los listados en §2") y su conteo declarado de "Total excluido: 20
IDs" (línea 33).

(Verificado contra: extracción completa de los 640 IDs de fuente vs. los citados en
`docs/REQUISITOS.md`; inspección manual de una muestra de los 88 resultados, incluidas las 4 filas
citadas arriba con su línea exacta en la fuente.)

### [MEDIO] `hotel-staff-pwa` se cita en dos requisitos pero ARQUITECTURA.md nunca lo define ni lo trata como PWA
`docs/REQUISITOS.md:57` (REQ-TEN-003), `:355` (REQ-UX-003) — `docs/ARQUITECTURA.md:261-289` (estructura de carpetas)

Escenario: dos requisitos (uno P0, uno P1) nombran literalmente `hotel-staff-pwa` —término tomado
fielmente de la fuente, `docs/referencia/01-blueprint-y-decision-llm.md:242` (BP-109), que también
usa exactamente esa palabra— como el componente que "solo debe mostrar al usuario las tareas de su
rol y turno del día". La estructura de carpetas de `ARQUITECTURA.md` (líneas 261-289) solo define
`apps/web` y `apps/api`; ADR-002 resuelve la experiencia móvil de housekeeping/mantenimiento
reutilizando `apps/web` con un patrón de bottom-nav, pero no menciona manifest de PWA, service
worker, instalabilidad ni comportamiento offline en ningún punto del archivo
(`grep -ic "service.worker\|manifest\|installable\|offline-first"` sobre `ARQUITECTURA.md` no
encuentra coincidencias relevantes a `hotel-staff-pwa`).

Consecuencia: queda sin decidir si "PWA" en el requisito es una etiqueta heredada del blueprint sin
consecuencia técnica, o una exigencia funcional real (instalable, con caché offline) que el diseño
actual de `apps/web` no contempla — riesgo de declarar "hecho" un requisito que en la práctica es
solo una vista responsiva sin ninguna propiedad de PWA.

(Verificado contra: `docs/referencia/01-blueprint-y-decision-llm.md:242`; `docs/ARQUITECTURA.md:261-289`.)

### [MEDIO] El "catálogo cerrado" de decisiones reservadas al fundador (REQ-GOB-012) omite ítems presentes en su propia fuente citada
`docs/REQUISITOS.md:390` vs. `docs/referencia/04-gobierno-y-protocolo.md:72` (GOB-051)

Escenario: REQ-GOB-012 se presenta como "un catálogo cerrado de decisiones reservadas
exclusivamente al fundador humano" y cita GOB-051 como una de sus fuentes. GOB-051 incluye
explícitamente "acciones con impacto reputacional externo" y "abandono de Lovable o convivencia con
este repo" —esto último directamente relevante aquí, dado que `docs/ARQUITECTURA.md:11,22` trata a
`atiende-restaurantes` como "repositorio hermano de solo lectura", una decisión de convivencia
entre repos— y "migración a LiveKit self-host" (LiveKit es parte del stack de voz ya elegido en
ADR-006). Ninguno de estos tres ítems aparece en el texto fusionado de REQ-GOB-012.

Consecuencia: si el criterio de "catálogo cerrado" se toma literalmente (tal como GOB-012 lo exige:
"cualquier cambio en estos dominios requiere aprobación explícita registrada del fundador"), una
decisión de migrar a LiveKit self-host o de cambiar la relación de convivencia con el repo de
restaurantes podría no activar la puerta de aprobación humana porque no está en el catálogo que
este requisito enumera, pese a que la fuente que cita sí la incluye.

(Verificado contra: `docs/REQUISITOS.md:390`; `docs/referencia/04-gobierno-y-protocolo.md:72`.)

### [MEDIO] REQ-RES-001 cita como fuente un requisito que no trata sobre cotización
`docs/REQUISITOS.md:66` — `docs/referencia/02-investigacion-H01-H11.md:189` (H03-007)

Escenario: REQ-RES-001 (P0) afirma que el sistema debe "cotizar y confirmar una reserva 24/7...
mostrando el precio total... desde la primera pantalla", citando nueve fuentes, entre ellas
H03-007. H03-007, confirmado contra el PDF original (`H03-comunicacion-huesped-recepcion-virtual.pdf`
p.12, sección "1. Pre-llegada" del journey), trata sobre el check-in online post-reserva
(OCR/firma/RFC), no sobre cotización ni sobre mostrar precio total.

Consecuencia: infla la base evidencial aparente del requisito P0 con más fuentes citadas (9) de las
que realmente lo sustentan de forma directa.

(Verificado contra: `docs/referencia/02-investigacion-H01-H11.md:189`; PDF `H03-...` p.12.)

### [MEDIO] REQ-RES-022 omite el calificador temporal de su fuente y lo presenta como prohibición permanente
`docs/REQUISITOS.md:87` — `docs/referencia/03-investigacion-H12-H21.md:74` (H15-006)

Escenario: REQ-RES-022 (P0, gobierno) dice "El sistema no debe construir conectividad OTA propia...
toda integración... se hace vía el channel manager/PMS certificado existente", sin calificador
temporal, citando H15-006. La fuente real, confirmada contra el PDF (`H15-integraciones-pms-apis-hotel.pdf`
p.22), dice literalmente: "no conectar OTAs directamente **antes de 24 meses**" — es una
restricción de fase con fecha de expiración implícita, no una prohibición permanente.

Consecuencia: un requisito P0 de gobierno queda redactado como regla fija cuando su propia fuente
la limita a 24 meses; quien lo implemente no sabrá, leyendo solo el requisito, que la restricción
está pensada para levantarse más adelante. Coincide con la contradicción #1 que el propio
`docs/REQUISITOS.md:405` ya reconoce a nivel de documento, pero esa matización no se refleja en el
texto del requisito mismo.

(Verificado contra: `docs/referencia/03-investigacion-H12-H21.md:74`; PDF `H15-...` p.22.)

### [MEDIO] Página de fuente citada incorrectamente para H04-018 (registro de jornada 2027)
`docs/referencia/02-investigacion-H01-H11.md:276` — PDF `H04-operaciones-backoffice-energia-hotel.pdf`

Escenario: la fila H04-018 cita "H04, p.14" como fuente de "El sistema debe registrar
electrónicamente la jornada laboral conforme al art. 132 fr. XXXIV LFT, exigible desde 1-ene-2027".
La página 14 del PDF contiene la sección "5.3 Puestos parcialmente automatizables y ahorro" y el
inicio de "6. Finanzas y fiscal" — no menciona el art. 132 ni la jornada laboral. El texto exacto
citado está en la **página 13** ("5.1 Ratios y costo", párrafo "Marco de nómina México 2026"),
confirmado con extracción de texto por página del PDF.

Consecuencia: baja en sí misma (REQ-HK-020/REQ-BO-024, que citan H04-018, sí describen fielmente el
contenido real de la fuente), pero quien use el número de página impreso para auditar directamente
el PDF sin verificar el texto no encontrará la cita donde se le indica.

(Verificado contra: PDF `H04-operaciones-backoffice-energia-hotel.pdf`, página 13 impresa.)

### [MEDIO] Prioridad inconsistente entre requisitos de accesibilidad/móvil derivados del mismo párrafo del encargo
`docs/REQUISITOS.md:353-355` (REQ-UX-001, REQ-UX-002, REQ-UX-003)

Escenario: REQ-UX-001 (paridad visual con Restaurantes) y REQ-UX-002 (estados vacíos/error
honestos) están marcados P0, citando como única fuente "Encargo-criterios" del mismo párrafo del
encargo (`/private/tmp/atiende-hoteles-encargo.md:16`: "...accesibilidad y experiencia móvil,
observabilidad y documentación operativa..."). REQ-UX-003 —"accesibilidad básica... y experiencia
funcional en móvil"— proviene textualmente del mismo párrafo del mismo encargo, pero está marcado
P1, un escalón por debajo de sus dos vecinos de la misma fuente.

Consecuencia: no hay ninguna razón declarada en el documento para tratar la accesibilidad/móvil
—criterio que el encargo pone al mismo nivel que paridad visual y estados vacíos— con una prioridad
menor; un lector no puede saber si es una decisión deliberada o un descuido de clasificación.

(Verificado contra: `/private/tmp/atiende-hoteles-encargo.md:16`; `docs/REQUISITOS.md:353-355`.)

### [BAJO] REQ-HUE-001 funde dos SLA de primera respuesta distintos sin señalar el conflicto
`docs/REQUISITOS.md:93` — `docs/referencia/01-blueprint-y-decision-llm.md:77` (BP-110), `docs/referencia/02-investigacion-H01-H11.md` (H07-010)

Escenario: REQ-HUE-001 cita BP-110 ("<2 min, 95% de casos") y H07-010 como si fijaran la misma
meta. H07-010, confirmado contra el PDF (`H07-innovacion-agentes-hotel.pdf` p.8, título de sección
"responder en 30 s en 5 idiomas"), exige "<30 s en el 90% de los casos" — un SLA distinto y más
estricto en tiempo, más laxo en porcentaje.

Consecuencia: ambigüedad sobre cuál SLA de primera respuesta es el vinculante; una prueba de
aceptación futura no sabrá si "pasar" significa <30 s o <2 min.

(Verificado contra: `docs/referencia/01-blueprint-y-decision-llm.md:77`; PDF `H07-...` p.8.)

### [BAJO] REQ-HUE-007 cita como fuente una suite de evals pre-release, no una auditoría de producción
`docs/REQUISITOS.md:99` — `docs/referencia/01-blueprint-y-decision-llm.md:236` (BP-103)

Escenario: REQ-HUE-007 ("auditar semanalmente una muestra de 30 conversaciones... para detectar
errores del bot") cita BP-103 junto a H03-024. BP-103, confirmado contra el PDF
(BLUEPRINT-HOTELES p.27, fila "Evals: simulador de huéspedes multilingüe, contract tests..."), es
sobre pruebas automatizadas pre-release, no sobre auditoría periódica de tráfico real en
producción.

Consecuencia: menor — H03-024 sí sustenta bien el requisito; BP-103 es una cita adicional forzada
que infla el respaldo aparente sin invalidar el requisito.

(Verificado contra: `docs/referencia/01-blueprint-y-decision-llm.md:236`; PDF BLUEPRINT-HOTELES p.27.)

### [BAJO] Dos celdas con texto roto en la tabla de hitos de ARQUITECTURA.md
`docs/ARQUITECTURA.md:296,298`

Escenario: la fila del hito H2 termina con "...H15-007, H15-020, H14-... (no aplica)" y la fila del
hito H4 empieza con "H14-... no aplica; H15-001...". En ambos casos el fragmento "H14-..." no
identifica ningún ID real (no existe ningún `H14-nnn` citado en el documento de forma que se
entienda qué se declaró "no aplica") y parece un resto de una edición anterior no limpiada.

Consecuencia: ninguna funcional, pero es ruido documental en una tabla que se usa como fuente de
verificación de cobertura de hitos.

(Verificado contra: `docs/ARQUITECTURA.md:296,298`.)

### [BAJO] `docs/audits/enterprise-remediation-2026-09-04.md`, citado por ADR-002, no existe en este repositorio
`docs/ARQUITECTURA.md:30`

Escenario: ADR-002 cita "`docs/audits/enterprise-remediation-2026-09-04.md` severidad 7" como
respaldo del hallazgo "no hay pruebas de accesibilidad automatizadas" en el frontend de
Restaurantes. En este repositorio (`atiende-hoteles-staging`) el directorio `docs/audits/` no
existe (`ls docs/audits/` → "No such file or directory"); la cita es válida solo dentro del
repositorio de referencia `atiende-restaurantes` (fuente indirecta vía
`docs/referencia/05-frontend-restaurantes.md`), pero `ARQUITECTURA.md` la presenta como si fuera
una ruta local, sin aclarar que es una ruta externa al repositorio que audita.

Consecuencia: menor — quien intente abrir esa ruta desde este repo para verificar el hallazgo no la
encontrará y podría concluir erróneamente que la cita es inventada, cuando en realidad es una
referencia heredada sin aclarar su origen externo.

(Verificado contra: `ls docs/audits/` en este repositorio → no existe.)

## Lo que revisé y está bien

- **Conteo de filas por módulo**: los 16 módulos cuadran exactamente entre la cabecera "0.
  Conteos" y el conteo real por `grep`/`awk` de las filas — TEN=6, RES=22, HUE=26, REC=14, HK=22,
  AB=14, REV=19, CRM=11, BO=35, AGT=21, INT=15, SEG=18, OBS=10, UX=6, QA=10, GOB=21 (total 270).
  Solo el desglose por prioridad de GOB (y por arrastre, el total general) falla — ver hallazgo ALTO.
- **Total de IDs de origen (≈640)**: confirmado exacto contando cada archivo de referencia
  (173 BP + 31 LLM + 288 H01-H11 + 89 H12-H21 + 59 GOB = 640).
- **Trazabilidad de ~56 REQ-* muestreados** contra sus fuentes citadas en `docs/referencia/01-04`,
  cubriendo los 16 módulos y las 4 prioridades: ningún requisito resultó inventado o falso; las
  cifras numéricas específicas verificadas coinciden exactamente con la fuente sin redondeos ni
  inflación, incluyendo 200 escenarios/10 de sensibilidad política (REQ-AGT-008), TTFT<600ms/
  p50<700ms/p95<1.5s (REQ-AGT-016), ≥1024/≥4096 tokens de prefijo cacheable (REQ-AGT-005), art. 132
  fr. XXXIV LFT desde 2027 (REQ-HK-020/BO-024), ISH 5%/DSA MXN20/ISN 4% de Quintana Roo (REQ-BO-007),
  techo de precio ≤20-30% del valor conservador (REQ-REV-019), límites de mensajería 1/día-4/año
  (REQ-HUE-020), RFC genérico XEXX010101000/régimen 616/uso S01 (REQ-BO-001), hold de 30 min/liberación
  por webhook (REQ-RES-003), probabilidad de no-show con clima/eventos (REQ-RES-009).
- **13 citas verificadas contra el PDF original con página exacta**: 12 confirmadas correctas
  (H03-007 p.12, H15-006 p.22, BP-103 p.27, BP-076 p.21, H07-010 p.8, NOM-251 en H10 p.9-10, reglas
  CFDI de hospedaje en H16 p.12-15, estándar antimonopolio de revenue en BLUEPRINT-HOTELES p.19,
  "overflow first" en H03 p.11, latencias de voz en DECISIONLLMHOTELES p.5, BP-053/shadow 90
  días/±10-15% en BLUEPRINT-HOTELES p.18, GOB-038/RLS en rules-db.pdf p.2); 1 desplazada en una
  página (H04-018, reportado en hallazgos).
- **Los 15 IDs de gobierno de Licitaciones declarados excluidos** (`docs/REQUISITOS.md:45`)
  efectivamente no aparecen citados en ninguna fila de la matriz fuera de la propia tabla de
  exclusión — consistente con lo declarado para ese subconjunto específico.
- **Honestidad de ARQUITECTURA.md sobre integraciones pendientes**: ADR-007 marca sistemáticamente
  PMS/WhatsApp/Pagos/CFDI/Voz/Correo como "[PENDIENTE DE CREDENCIALES]" sin ninguna excepción que
  las declare completas por tener solo un mock, consistente con `docs/REQUISITOS.md` §5.
  Regla GOB-013/GOB-032 (determinismo de precio/impuesto) reflejada sin contradicción entre
  REQUISITOS (REQ-REV-001, REQ-AGT-004) y ARQUITECTURA (ADR-006).
- **Mediciones de rendimiento citadas en ADR-003** (1344 ms PGlite serializado vs. 302 ms
  `embedded-postgres` con concurrencia real) coinciden exactamente con
  `docs/referencia/07-stack-viabilidad.md`, sin inflación.
- **`docs/auditoria/RUBROS.md` y `docs/auditoria/AUDITOR-PROMPT.md`**: todas las referencias
  cruzadas a ADR-002/004/005/006/007/009/010 verificadas corresponden a contenido real de esos ADR,
  no a decisiones inventadas; el diseño del protocolo (contexto fresco, prohibición de proponer
  arreglos, exigencia de contar lo descartado) es coherente y no se contradice a sí mismo.
- **`docs/logs/bucle.log`** corrobora, no contradice, la afirmación de `docs/operacion-bucle.md`
  sobre el primer disparo real del cron `f24bfd35` (19:07, mismo día).

## Lo que NO alcancé a revisar

- No se verificaron uno a uno los ~214 REQ-* restantes de los 270 (se cubrió una muestra de ~56,
  bien repartida por módulo/prioridad, no la totalidad); la ausencia de hallazgos en la muestra no
  garantiza que el resto esté libre de problemas similares a los ya encontrados (citas infladas,
  calificadores omitidos).
- De los 88 IDs de origen sin citar ni excluir, solo se inspeccionó manualmente una muestra de
  ~6 (GOB-025, H06-001, H09-001, H04-012, H04-025, H18-003/004); el resto (mayormente clusters de
  H04, H06, H07, H08, H09) podría incluir más funcionalidad de producto genuina sin cubrir, o
  legítimos duplicados de conceptos ya citados desde otra fuente — no se clasificó cada uno.
- No se releyeron completos `docs/referencia/05-frontend-restaurantes.md` y
  `docs/referencia/06-backoffice-agentes-likida.md` línea por línea contra cada cita de ADR-002/006/010
  de `ARQUITECTURA.md` más allá de las citas puntuales verificadas (patrones de Likida, hallazgos de
  accesibilidad/mobile de Restaurantes); no se descarta que existan más citas puntuales inexactas
  en esas secciones.
- No se verificó independientemente la existencia real de la sesión de Claude Code, el cron
  `f24bfd35` ni el estado "Sonnet #N en curso" citados en `docs/operacion-bucle.md`/`docs/PROGRESO.md`
  más allá de cotejar `docs/logs/bucle.log`, que es evidencia consistente pero generada por el mismo
  proceso que se audita, no una fuente externa independiente.
- `docs/ACEPTACION.md`, `docs/AGENTES.md`, `docs/PROGRESO.md` y `docs/BLOQUEOS.md` completo no
  estaban en el alcance explícito de esta auditoría (no listados en el encargo de auditoría) y solo
  se consultaron puntualmente como corroboración cruzada (p. ej. para el hallazgo del catálogo de
  roles); no recibieron una revisión adversarial propia.
- No se recorrieron las 10 contradicciones de `docs/REQUISITOS.md` §4 una por una contra el PDF
  para confirmar que cada una está bien planteada por el propio documento — se tomó su formulación
  como correcta y se verificó únicamente que `ARQUITECTURA.md` no las resuelve por nombre.
