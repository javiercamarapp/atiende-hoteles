# Auditoría adversarial de documentos — Atiende Hoteles (ronda 0)

Auditor: Sonnet, contexto fresco. Objeto: `docs/REQUISITOS.md`, `docs/ARQUITECTURA.md`,
`docs/auditoria/RUBROS.md`, `docs/auditoria/AUDITOR-PROMPT.md`, `docs/BLOQUEOS.md`,
`docs/operacion-bucle.md`. Fuentes de verdad: `docs/referencia/01..07` y PDF original en
`/Users/javiercamaraportepetit/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF/`.

## Notas por documento

**`docs/REQUISITOS.md` — 7/10.** El contenido de cada fila es, en la muestra verificada (26
requisitos de 16 módulos y las 3 prioridades, más 6 páginas de PDF confirmadas), fiel a sus
fuentes: no encontré ningún requisito inventado, tergiversado ni inflado. El problema no está en
lo que el documento afirma sobre sí mismo en sus renglones, sino en lo que afirma sobre su propia
completitud (§0-§2): el conteo de prioridades del módulo GOB no cuadra con las filas reales, y la
tabla de "IDs excluidos deliberadamente" (§2) declara 20 IDs excluidos cuando en realidad 88 IDs
de origen (13.8% de los ≈640) no aparecen citados en ninguna fila ni en esa tabla — incluida
`GOB-025`, una regla de gobierno central para este producto (aislamiento de contexto entre
tenants en los prompts de agentes).

**`docs/ARQUITECTURA.md` — 6/10.** Las citas de evidencia que verifiqué contra
`docs/referencia/07-stack-viabilidad.md` (mediciones de 1344ms/302ms de concurrencia) son exactas,
y el manejo de "pendiente de credenciales" es honesto y consistente en toda la tabla de
integraciones (ADR-007). Pero el documento deja sin ningún ADR, puerto o hito a un dominio entero
con múltiples requisitos P0 (energía/IoT/HVAC/cerraduras — REQ-BO-027/028/029, REQ-INT-007,
REQ-SEG-015), y no resuelve la contradicción #2 que el propio `REQUISITOS.md` le asigna
explícitamente para decidir ("modo huracán/degradado offline vs. Supabase/Postgres remoto") antes
de construir el módulo afectado.

**`docs/auditoria/RUBROS.md` — 8/10.** Documento metodológico bien construido; sus referencias a
ADR/GOB que verifiqué (ADR-002 a ADR-010, GOB-013/026/032/059) citan contenido real y consistente
con `ARQUITECTURA.md`. No encontré afirmaciones fácticas propias que contradigan las fuentes.

**`docs/auditoria/AUDITOR-PROMPT.md` — 8/10.** Consistente con `RUBROS.md` y con el mecanismo de
Likida descrito en `06-backoffice-agentes-likida.md` §4. No contiene afirmaciones verificables
propias fuera de proceso/formato.

**`docs/BLOQUEOS.md` — 6/10.** B-001 está bien documentado con evidencia de búsqueda. B-002
contiene una cifra ya obsoleta y no corregida: cita `vitest@5.0.0` como "resolvible", cuando la
propia investigación en `docs/referencia/07-stack-viabilidad.md` (Experimento 1, ejecutada el
mismo día) documenta que la instalación real resolvió `vitest@4.1.11`, explícitamente contradiciendo
"un chequeo anterior" que había visto 5.0.0.

**`docs/operacion-bucle.md` — 6/10.** Internamente consistente y sin contradicciones detectables
contra los demás documentos, pero la mayoría de sus afirmaciones (IDs de cron, estado de sesión,
"Sonnet #8 en curso") son estado operativo no verificable desde los archivos que tengo a la vista;
no encontré una afirmación falsa, pero tampoco pude confirmar la mayoría como verdaderas.

## Hallazgos

### [CRÍTICO] Regla de gobierno GOB-025 (aislamiento de tenant en prompts) desaparece sin justificación
`docs/REQUISITOS.md:38` y `docs/REQUISITOS.md:40-47` (§1 y §2) — `docs/referencia/04-gobierno-y-protocolo.md:46`
Escenario: `docs/REQUISITOS.md:38` afirma "no se descarta ningún ID origen salvo los listados en
§2", y §2 (líneas 40-47) declara una lista cerrada de exactamente 20 IDs excluidos con razón
escrita. `GOB-025` (04-gobierno-y-protocolo.md:46: "Aislamiento entre tenants en los prompts: el
contexto de un agente solo incluye datos del tenant en curso... prohibido few-shot con propuestas
de otros tenants... redacción de PII antes de cualquier traza") no aparece en ningún renglón de
`REQUISITOS.md` (verificado con `grep -c "GOB-025" docs/REQUISITOS.md` → 0) ni en la tabla de
exclusión del §2. No es un ID de mercado/negocio ni específico de Licitaciones (las dos únicas
categorías que el §2 declara como motivo de exclusión) — es exactamente el tipo de regla que
`docs/auditoria/RUBROS.md:71` describe como "el eje propio de este producto frente a Likida":
que ningún dato cruce de un hotel a otro.
Consecuencia: una regla de gobierno sobre fuga de contexto entre tenants en los prompts de
agentes de IA — el riesgo que este producto más necesita prevenir según su propia auditoría — no
tiene ningún requisito canónico que la trazabilidad de implementación pueda verificar ni cerrar.
(Verificado contra: `docs/referencia/04-gobierno-y-protocolo.md:46`; comando
`grep -oE '\b(BP|LLM|H0[1-9]|H1[0-9]|H2[01]|GOB)-[0-9]+\b' docs/REQUISITOS.md | sort -u` comparado
contra el catálogo completo de IDs de origen de las 4 fuentes con `comm -23`.)

### [ALTO] Conteo de prioridades del módulo GOB no cuadra con sus propias filas
`docs/REQUISITOS.md:26` (tabla de §0) vs. `docs/REQUISITOS.md:379-399` (filas reales GOB-001..021)
Escenario: la tabla de conteos declara GOB con P0=15, P1=3, P2=3 (línea 26). El conteo real de las
21 filas GOB (comando: `awk -F'|' '/^\| REQ-GOB-/{print $5}' docs/REQUISITOS.md | sort | uniq -c`)
da P0=14 (GOB-001 a 007, 009 a 013, 016, 019), P1=4 (GOB-008, 014, 020, 021), P2=3 (GOB-015,
017, 018). El total de la fila (21) sí cuadra, pero el desglose por prioridad no.
Consecuencia: cualquier reporte de avance que use esta tabla como línea base ("X de 15 P0 de GOB
completados") estará contando sobre un denominador equivocado desde el primer día.
(Verificado contra: conteo directo del propio documento con `awk`/`grep`, sin fuente externa
necesaria — es una inconsistencia interna.)

### [ALTO] Dominio Energía/IoT/HVAC/cerraduras sin ningún ADR, puerto ni hito, pese a tener 5 requisitos P0
`docs/ARQUITECTURA.md:176-184` (tabla de integraciones de ADR-007) y `docs/ARQUITECTURA.md:291-305`
(tabla de hitos H1-H10) — `docs/REQUISITOS.md:255-257,301,329`
Escenario: `docs/REQUISITOS.md` fija como P0 la lectura de telemetría de energía (REQ-BO-027,
línea 255), el control de HVAC por estado del PMS (REQ-BO-028, línea 256), la ejecución local de
reglas de seguridad de energía con prioridad de huésped (REQ-BO-029, línea 257) y la integración
obligatoria de hardware IoT de energía/edge (REQ-INT-007, línea 301); REQ-SEG-015 (línea 329, P0)
exige que las cerraduras nunca se gestionen por reglas automáticas. La tabla de integraciones de
`ARQUITECTURA.md` (ADR-007, líneas 176-184) solo lista PMS, WhatsApp, Pagos, CFDI, Voz y
Correo — ningún puerto `EnergyPort`/`LockPort` ni fila para Home Assistant/Shelly/Seam. La tabla
de hitos H1-H10 (líneas 291-305) tampoco asigna ningún hito a energía/edge/cerraduras: H6 cubre
housekeeping/mantenimiento + WhatsApp + `agent-core`; H9 cubre "adaptadores reales de integración
(PMS/WhatsApp/pagos/CFDI/voz)" sin mencionar energía ni cerraduras. La única mención de
"Home Assistant" en todo el archivo (línea 316) es la fila de PowerSync en la tabla de desvíos,
que solo explica por qué no hay sincronización offline-first, no por qué falta el puerto de
energía en sí.
Consecuencia: un lector que use `ARQUITECTURA.md` para planear la construcción no encontrará
ningún ADR que decida el contrato/adaptador de energía o cerraduras, ni un hito que lo agende —
5 requisitos P0 (energía, IoT, cerraduras) quedan sin ruta de implementación documentada, a
diferencia de PMS/WhatsApp/pagos/CFDI/voz que sí tienen puerto+adaptador+estado declarado.
(Verificado contra: `docs/REQUISITOS.md` líneas citadas y `docs/ARQUITECTURA.md` completo, grep
de "energ|iot|home assistant|shelly|seam|cerradura|hvac" sobre `docs/ARQUITECTURA.md` → solo
3 coincidencias, ninguna en ADR-007 ni en la tabla de hitos.)

### [ALTO] Contradicción #2 de REQUISITOS ("modo huracán offline vs. Supabase/Postgres remoto") declarada pendiente de arquitectura y nunca resuelta
`docs/REQUISITOS.md:406` (contradicción #2, §4) — `docs/ARQUITECTURA.md` (ausente)
Escenario: `docs/REQUISITOS.md:403` establece la regla: las contradicciones de §4 "quedan
documentadas para el documento de arquitectura..., que deberá decidir cada una explícitamente
antes de construir el módulo afectado". La contradicción #2 (línea 406) es explícita: "H20-001
fija Supabase (Postgres cloud con RLS) como base de datos de la plataforma, mientras
BP-018/BP-116/BP-160/REQ-REC-013 exigen un 'modo huracán/degradado de 72h' con copia local
cifrada de rooming list, folios y llaves y check-in offline... no explican cómo el edge local
reconcilia esa copia cifrada con Supabase al reconectar". `ARQUITECTURA.md` no contiene ninguna
mención de "huracán", "offline" (fuera de "tests offline" de CI, línea 222, que es un concepto
distinto), "degradado" ni "72h" en ningún ADR; la única referencia a sincronización de edge
(línea 316, desvío #7) es sobre PowerSync para IoT de energía, no sobre el modo huracán del
huésped/reserva/folio/llave de REQ-REC-013.
Consecuencia: REQ-REC-013 (P1, "modo huracán/degradado de 72h") queda sin decisión de
arquitectura documentada sobre cómo se sincroniza la copia local cifrada con la base remota —
exactamente el vacío que el propio `REQUISITOS.md` pidió cerrar antes de construir el módulo.
(Verificado contra: `docs/REQUISITOS.md:401-414` completo y `docs/ARQUITECTURA.md` completo vía
grep de los términos citados.)

### [MEDIO] `hotel-staff-pwa` se cita como app distinta sin tratamiento arquitectónico (PWA/offline)
`docs/REQUISITOS.md:57` (REQ-TEN-003), `docs/REQUISITOS.md:355` (REQ-UX-003) —
`docs/ARQUITECTURA.md:261-289` (estructura de carpetas)
Escenario: dos requisitos P0/P1 nombran explícitamente `hotel-staff-pwa` como el componente que
"solo debe mostrar al usuario las tareas de su rol y turno del día" — término tomado fielmente de
la fuente (`BP-109`, `docs/referencia/01-blueprint-y-decision-llm.md:242`, que también usa
literalmente "`hotel-staff-pwa`"). La estructura de carpetas propuesta en `ARQUITECTURA.md`
(líneas 261-289) solo define `apps/web` y `apps/api`; ADR-002 explica que housekeeping/
mantenimiento usan el mismo `apps/web` con un patrón de bottom-nav, pero no menciona manifest de
PWA, service worker, instalabilidad ni comportamiento offline en ningún punto del documento.
Consecuencia: no queda decidido si "PWA" en el requisito es solo una etiqueta heredada del
blueprint o una exigencia funcional real (instalable, con caché offline) que el diseño actual de
`apps/web` no contempla — riesgo de que se declare "hecho" un req que en realidad solo es una
vista responsiva sin ninguna de las propiedades que distinguen una PWA.
(Verificado contra: `docs/referencia/01-blueprint-y-decision-llm.md:242`.)

### [MEDIO] Página de fuente citada incorrectamente para H04-018 (registro de jornada 2027)
`docs/referencia/02-investigacion-H01-H11.md:276` — PDF: `H04-operaciones-backoffice-energia-hotel.pdf`
Escenario: la fila H04-018 cita "H04, p.14" como fuente del requisito "El sistema debe registrar
electrónicamente la jornada laboral conforme al art. 132 fr. XXXIV LFT, exigible desde
1-ene-2027". Abrí la página 14 del PDF original: contiene la sección "5.3 Puestos parcialmente
automatizables y ahorro" y el inicio de "6. Finanzas y fiscal" — no menciona el art. 132 ni la
jornada laboral. El texto exacto citado ("registro electrónico de jornada (art. 132 fr. XXXIV
LFT) plenamente exigible desde 1-ene-2027") está en la **página 13** ("5.1 Ratios y costo",
párrafo "Marco de nómina México 2026"), confirmado con `pdftotext` + inspección visual de la
página.
Consecuencia: bajo, porque REQ-HK-020/REQ-BO-024 (que citan H04-018) sí describen fielmente el
contenido real de la fuente — solo la página impresa está desplazada en una unidad. Si alguien
usa el número de página para auditar directamente el PDF sin verificar el texto, no encontrará la
cita donde se le indica.
(Verificado contra: `H04-operaciones-backoffice-energia-hotel.pdf`, página 13 impresa — el
comando `pdftotext -layout` + `awk` sobre saltos de página `\f` confirma "art. 132 fr." en la
página 13, no en la 14.)

### [BAJO] `docs/BLOQUEOS.md` cita una versión de `vitest` ya contradicha por la propia investigación posterior
`docs/BLOQUEOS.md:18` — `docs/referencia/07-stack-viabilidad.md:47-48`
Escenario: `docs/BLOQUEOS.md:18` (B-002) afirma "Hay red npm (`@electric-sql/pglite@0.5.8`,
`supabase@2.116.0`, `vitest@5.0.0` resolvibles)". `docs/referencia/07-stack-viabilidad.md:47-48`
(Experimento 1, mismo día) documenta la instalación real: "vitest resolvió 4.1.11, no 5.0.0 como
se había visto disponible en un chequeo anterior". `BLOQUEOS.md` no se actualizó para reflejar
esta corrección.
Consecuencia: menor — no bloquea nada por sí sola, pero es un ejemplo de una cifra verificada
como incorrecta en un documento posterior que no se propaga hacia atrás al documento que la
citó primero.
(Verificado contra: `docs/referencia/07-stack-viabilidad.md:47-48`.)

### [BAJO] Brecha entre la cobertura de fuentes declarada (20 IDs excluidos) y la real (88 IDs sin citar)
`docs/REQUISITOS.md:33,40-47` — catálogo completo de IDs de origen en `docs/referencia/01-04`
Escenario: además de `GOB-025` (ya reportado como CRÍTICO por su naturaleza), otros 87 IDs de
origen no aparecen citados en ninguna fila de `REQUISITOS.md` ni en la tabla de exclusión del §2.
La mayoría son plausiblemente narrativos/de mercado (p. ej. la mitad de H06 — "Competencia
hoteltech/TAM"), pero al menos dos son funcionalidad de producto genuina y ausente de cualquier
REQ: `H04-012` (dimensionamiento/monitoreo de instalación solar fotovoltaica,
`docs/referencia/02-investigacion-H01-H11.md:270`) y `H04-025` (analítica de video para intrusión
perimetral/conteo de personas sobre CCTV existente,
`docs/referencia/02-investigacion-H01-H11.md:283`) — ninguno de los dos tiene REQ-* propio ni
aparece mencionado en ningún otro renglón (`grep -in "solar\b"` y `grep -in "video\|intrusi"` en
`docs/REQUISITOS.md` no devuelven ninguna fila funcional que los cubra).
Consecuencia: el documento subestima en la práctica cuántos requisitos de origen quedaron fuera
de alcance sin decisión explícita; dos de ellos (solar, analítica de video) son capacidades de
producto reales, no solo contexto narrativo.
(Verificado contra: comparación completa de IDs con `comm -23` entre el catálogo de origen — 640
IDs — y los IDs citados en `docs/REQUISITOS.md` — 552 únicos —, filtrando duplicados de
ordenamiento; inspección manual de una muestra de los 88 resultados.)

## Lo que revisé y está bien

- **Trazabilidad de 26 REQ muestreados** (AB-002, AB-011, AB-013, REV-004, REV-018, REV-019,
  CRM-004, BO-001, BO-007, BO-010, BO-035, HUE-004, HUE-013, HUE-020, HUE-021, HK-001, HK-020,
  AGT-008, AGT-013, AGT-016, SEG-004, SEG-009, INT-001, GOB-012, BO-024 y el conteo total de
  filas) contra sus fuentes citadas en `docs/referencia/01-04`: ninguno resultó inventado, falso
  ni sustancialmente inflado. Las cifras numéricas específicas verificadas coinciden exactamente
  con la fuente: 200 escenarios/10 de sensibilidad política (`docs/referencia/01-blueprint-y-decision-llm.md:376-377`),
  TTFT<600ms/p50<700ms/p95<1.5s (`:366`), art. 132 fr. XXXIV LFT desde 2027 (`docs/referencia/02-investigacion-H01-H11.md:276,816`),
  ISH 5%/DSA MXN20/ISN 4% de Q. Roo (`docs/referencia/03-investigacion-H12-H21.md:96-101`), techo
  de precio ≤20-30% y factor de dedup 0.75 (`:114-115`).
- **6 citas de página verificadas contra el PDF original** (H10 p.9-10 para NOM-251, H16 p.12-15
  para reglas CFDI de hospedaje, BLUEPRINT-HOTELES p.19 para el estándar antimonopolio de
  revenue, H03 p.11 para "overflow first", DECISIONLLMHOTELES p.5 para latencias de voz): 5 de 6
  correctas; 1 desplazada en una página (H04-018, reportado arriba).
- **Conteo total de REQUISITOS.md**: 270 filas, desglose por módulo y por prioridad correcto en
  15 de 16 módulos (verificado con `awk`/`grep` línea por línea contra la tabla de §0); el total
  de ≈640 IDs de origen (173+31+288+89+59) también se confirmó exacto contando cada archivo de
  referencia.
- **Mediciones citadas de `07-stack-viabilidad.md` en `ARQUITECTURA.md`** (1344ms serializado en
  PGlite vs. 302ms de concurrencia real en `embedded-postgres`, ADR-003): coinciden exactamente
  con `docs/referencia/07-stack-viabilidad.md:99,155`. No hay inflación de estas cifras.
- **Honestidad sobre integraciones pendientes**: `docs/ARQUITECTURA.md` ADR-007 (líneas 174-189)
  marca sistemáticamente PMS/WhatsApp/Pagos/CFDI/Voz/Correo como "[PENDIENTE DE CREDENCIALES]"
  sin ninguna excepción que las declare completas por tener solo un mock — consistente con
  `docs/REQUISITOS.md` §5 (líneas 416-438), que exige lo mismo.
- **Regla de gobierno GOB-013/GOB-032** (determinismo de precio/impuesto, prohibición de que el
  LLM calcule tarifa/ISH/IVA) está reflejada de forma consistente y repetida en REQUISITOS
  (REQ-REV-001, REQ-AGT-004) y en ARQUITECTURA (ADR-006), sin contradicción entre documentos.
- **`docs/auditoria/RUBROS.md` y `docs/auditoria/AUDITOR-PROMPT.md`**: las referencias cruzadas a
  ADR-002/004/005/006/007/009/010 de `ARQUITECTURA.md` citadas en ambos documentos corresponden a
  contenido real de esos ADR (verificado por lectura directa), no a ADR inventados.

## Lo que NO alcancé a revisar

- **Módulos completos de fuentes H05, H06, H17 (más allá de lo citado en la muestra) y H18**: no
  leí estos documentos de referencia línea por línea; los usé solo vía grep dirigido a IDs
  específicos citados por la muestra de REQ verificados. No puedo garantizar que no haya más IDs
  con el mismo patrón de tergiversación que los que sí revisé (aunque no encontré ninguno en la
  muestra).
- **Los otros 62 de los 88 IDs de origen sin citar**: solo inspeccioné manualmente H04-012 y
  H04-025 como muestra; el resto (mayormente H06 de mercado, algo de H07/H08/H09) podría incluir
  más funcionalidad de producto genuina sin cubrir, no solo narrativa de negocio descartable.
- **`docs/PROGRESO.md`, `docs/AGENTES.md`, `docs/logs/bucle.log`**: no estaban en el alcance
  explícito de esta auditoría (no listados en el encargo de auditoría), no los leí.
- **Verificación independiente de las afirmaciones operativas de `docs/operacion-bucle.md`**
  (existencia real del cron `f24bfd35`, estado de "Sonnet #8 en curso"): no tengo acceso a
  herramientas de sesión/cron para confirmarlas de forma independiente; las traté como no
  verificables, no como falsas.
- **Todos los ADR de `ARQUITECTURA.md` frente a `docs/referencia/06-backoffice-agentes-likida.md`**:
  verifiqué solo las citas de ADR-006/ADR-010 relacionadas con los hallazgos reportados; no
  contrasté línea por línea cada referencia a Likida (§2.2-2.7, §4, §5) contra ese documento de
  636 líneas.
- **El resto de las 244 filas de REQUISITOS.md no muestreadas** (se revisaron 26 de 270): la
  ausencia de hallazgos en la muestra no garantiza que las 244 restantes estén libres de
  problemas similares.
