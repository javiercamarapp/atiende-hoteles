# Los doce rubros — Atiende Hoteles

Cada auditor recibe **solo su sección**. Mandarle las doce lo vuelve superficial en todas.

Adaptado de `docs/referencia/06-backoffice-agentes-likida.md` §4.3 (skill `auditoria-diaria` de Likida) a la arquitectura fijada en `docs/ARQUITECTURA.md` (ADR-001..010 y "Estructura de carpetas propuesta") y a las reglas de gobierno de `docs/referencia/04-gobierno-y-protocolo.md` (GOB-nnn). Likida liquida viajes de carga por WhatsApp con un solo agente y un solo tenant por conversación; Atiende Hoteles opera reservas/folio/housekeeping/tarifas para **muchos hoteles en la misma base** (`tenant_id = org_id`; cada hotel es una `location` bajo esa `org`, con `hotel_id` como scope secundario dentro del tenant — `REQ-TEN-002`, ADR-004/005), con dinero de terceros (huésped), datos de identidad (bóveda GOB-044) y obligaciones fiscales propias del hospedaje (ISH, CFDI 4.0). El eje que Likida no tiene y aquí es central: **fuga entre hoteles** — un dato, una tarifa o un mensaje que cruza de `hotel A` a `hotel B` es su propio tipo de hallazgo, distinto de un bug de lectura o de dinero.

Índice: [1 Frontend](#1-frontend-ux-accesibilidad-y-móvil) · [2 Backend y API](#2-backend-y-api) · [3 Agéntico](#3-sistema-agéntico-y-orquestación) · [4 Tool calling](#4-tool-calling-y-autorización) · [5 Seguridad](#5-seguridad-y-aislamiento-multi-tenant) · [6 Fiscal](#6-cumplimiento-fiscal-cfdi-40-hotelero--ish--iva) · [7 Legal](#7-cumplimiento-legal-y-privacidad-lfpdppp-2025) · [8 Arquitectura](#8-arquitectura-y-mantenibilidad) · [9 Pruebas](#9-pruebas) · [10 Operabilidad](#10-operabilidad-y-dx) · [11 Rendimiento](#11-rendimiento-y-costo-incl-costo-llm-por-hotel) · [12 Modelo de datos](#12-modelo-de-datos-y-esquema-reservas-disponibilidad-folio) · [Escala](#la-escala-0-10)

Notas de arranque (ronda 1, sin ronda anterior): todos los rubros parten sin nota — la primera síntesis no tiene delta, solo línea base. A partir de la ronda 2 aplica la regla de movimiento de la sección final.

---

## 1 · Frontend/UX, accesibilidad y móvil

**Dueño de** lo que recepción, gerencia, housekeeping y mantenimiento ven y tocan: paneles, tablas, calendario de disponibilidad, estados vacíos/carga/error, accesibilidad, experiencia móvil real en tablet/celular (housekeeping y recepción operan de pie, no en escritorio).

**Dónde:** `apps/web/` (ADR-002), en particular el sidebar hotelero (`AdminSidebar` adaptado), el bottom-nav `md:hidden` para housekeeping/mantenimiento (patrón `RepartidorDashboard.tsx` portado), `EstadoVacio`/`EstadoError`/`EstadoCargando` (patrón Likida §3.5), `ThemeSelector`, y las suites `axe-core` (ADR-002, ADR-009).

**Requisitos-ancla (REQ-*):** REQ-UX-001, REQ-UX-002, REQ-UX-003.

**Qué cuenta:** un mapa de estados de habitación (`disponible|ocupada|sucia|fuera_de_servicio|mantenimiento`, ADR-005) que ya no cuadra con los estados reales del backend y pinta una habitación sucia como disponible; el panel de housekeeping en mobile que solo renderiza el header y deja el contenido en `hidden md:flex` (el hueco que ADR-002 dice haber cerrado — verificar que de verdad se cerró, no que quedó documentado); una tarifa o un total de folio formateado distinto en el panel de recepción y en el PDF/WhatsApp del huésped; un `key` de React inestable que reordena filas de cargos a folio; contraste o tamaño de toque que reprueba en la vista de tablet de housekeeping; un estado de error de servidor que llega a la pantalla del huésped como stack trace.

**El sesgo a corregir:** el panel se ve bien en escritorio con datos de demo — auditar explícitamente el viewport `375×812` (mobile real, no responsive "encogido") en las pantallas que housekeeping/mantenimiento usan de pie, y comparar cada mapa literal de estados contra `packages/domain-hotel`/`packages/db` (no contra la memoria de qué estados "deberían" existir).

**Anclas:** 8+ si cada estado (vacío, cargando, error, parcial) está pintado a propósito, los mapas derivan del tipo compartido y la vista mobile de housekeeping es funcional sin scroll horizontal. 6 si el camino feliz de escritorio se ve bien y mobile es usable pero no probado con `axe`. 4 o menos si el gerente puede ver una tarifa mal formateada, una pantalla en blanco, o housekeeping no puede operar desde su tablet.

---

## 2 · Backend y API

**Dueño de** rutas Hono, contratos de entrada/salida, concurrencia, idempotencia, manejo de errores del servidor, transacciones con dinero de huésped.

**Dónde:** `apps/api/` (ADR-004): handlers de reservas/disponibilidad/folio/pagos, `set_config` de claims RLS por request, constraint `UNIQUE (tenant_id, idempotency_key)`, `pg_advisory_xact_lock` sobre `(hotel_id, room_type_id, fecha)`, tabla `outbox` con backoff.

**Requisitos-ancla (REQ-*):** REQ-TEN-001, REQ-REC-003, REQ-REC-004, REQ-RES-002, REQ-RES-007.

**Qué cuenta:** un `if` que detecta doble-reserva y no hace `return`; un handler de cargo a folio cuyo `INSERT` no está protegido por el `idempotency_key` y que un reintento de red duplica; un advisory lock que se pide para disponibilidad pero no para el cierre de folio (dos cajeros cierran el mismo folio a la vez); un `catch` que traga el error del conector PMS sin registrar qué reserva falló; un endpoint que acepta un `hotel_id` del body en vez de tomarlo del JWT de sesión (abre la puerta a operar sobre el hotel equivocado); un contrato que acepta una tarifa negativa o un `room_type_id` inexistente.

**El sesgo a corregir:** este código se lee correcto. Leer no es verificar — para cada camino de concurrencia sobre disponibilidad/folio/pago, decir explícitamente si existe una prueba en `tests/integration/` contra `embedded-postgres` (ADR-003/009) que lo cubra, y nombrarla. Un camino "correcto por lectura" sin esa prueba es una nota de 6, no de 8.

**Anclas:** 8+ si cada camino que toca disponibilidad, folio o pago tiene prueba de concurrencia propia contra `embedded-postgres` y los errores se propagan con el identificador de la fila (`reservation_id`/`folio_id`). 6 si es correcto por lectura y la prueba de concurrencia no existe o solo corre contra PGlite (que serializa, ADR-003). 4 o menos si existe un camino donde una habitación se puede reservar dos veces o un cargo se puede postear dos veces.

---

## 3 · Sistema agéntico y orquestación

**Dueño de** el ciclo de vida de una conversación con el huésped o el staff: quién habla, cuándo, con qué contexto, qué pasa si el proceso muere a la mitad, qué texto sale hacia el humano, cómo se cierra una tarea de agente que quedó pendiente de aprobación.

**Dónde:** `packages/agent-core/` (registro de agentes, `ToolContext`, loop-guard, presupuesto, cola de `agent_task`/`approval` — ADR-006), runtime por rol (Sonnet/Haiku/Opus vía env, ADR-006), disclosure engine (GOB-015/034).

**Requisitos-ancla (REQ-*):** REQ-AGT-001, REQ-AGT-002, REQ-AGT-022, REQ-HUE-006.

**Qué cuenta:** el destinatario equivocado (un veredicto de revenue que es para el gerente y llega al huésped por WhatsApp); una `agent_task` que queda en `pendiente_aprobacion` sin que nadie la vea porque el canal de notificación cayó; una carrera entre dos mensajes del mismo huésped en el mismo lote (dos solicitudes de late check-out que ambas leen disponibilidad antes de que la primera decremente); un prompt que autoriza al modelo a narrar una tarifa o un cargo en vez de citar el número que devolvió el motor determinista; un reintento de la llamada al LLM que duplica un efecto (enviar el mismo mensaje de bienvenida dos veces); el caso "se trabó" donde el huésped nunca recibe confirmación de su reserva aunque la reserva sí se creó en la base.

**La pregunta que ordena el rubro:** si el proceso muere en este punto exacto de la conversación, ¿qué ve el huésped o el staff, y qué quedó en la base? Recorrer el ciclo punto por punto con esa pregunta (mensaje entrante → tool call → aprobación pendiente → respuesta) encuentra más que leer el código de corrido.

**Anclas:** 8+ si cada punto de muerte del ciclo tiene un cierre definido hacia el humano (huésped o staff) y el disclosure de IA aparece donde GOB-034 lo exige. 5–6 si el camino feliz es sólido y los bordes (reintentos, aprobaciones pendientes, mensajes concurrentes) son suposiciones sin prueba. 3 o menos si existe un estado donde la base dice una cosa (reserva creada, cargo posteado) y el huésped o el staff cree otra.

---

## 4 · Tool calling y autorización

**Dueño de** la frontera entre el modelo y el mundo: definición de tools de dominio (cotizar tarifa, crear ticket de housekeeping, cerrar folio), argumentos, ejecución, `needs_approval`, loop-guard, fallback entre proveedores, contabilidad de tokens y costo.

**Dónde:** `packages/agent-core/` (tool registry, `ToolContext`), `packages/domain-hotel/` (motores deterministas que las tools invocan), runtime LLM (ADR-006).

**Requisitos-ancla (REQ-*):** REQ-AGT-001, REQ-AGT-004, REQ-AGT-002, REQ-REV-001.

**Qué cuenta:** un parámetro que el modelo puede llenar y que decide sobre dinero, tarifa o a qué hotel/huésped pertenece un dato (una tool de cotización que acepta `hotel_id` o `precio` del modelo en vez de resolverlos server-side rompe el patrón `properties: {}` de ADR-006); una tool de precio/tarifa/impuesto/disponibilidad que en algún camino se resuelve por generación libre del LLM en vez del motor determinista (violación directa de GOB-013/032); una tool con efecto externo o económico sin `needs_approval: true`, o con `always_approve` en precio/emisión (prohibido a nivel de tipo, GOB-026 adaptado); un loop-guard que cuenta mal y ejecuta una mutación adicional después de agotar `maxRounds`; un fallback de proveedor que cambia de modelo sin cambiar la atribución de costo; una tool que se ejecuta dos veces porque la deduplicación mira la llamada y no el efecto (mismo riesgo que Likida documenta en `tool-executor.ts`, `06-backoffice-agentes-likida.md` §2.5).

**Lo que hay que reconocer, no "encontrar":** el patrón decidido en ADR-006 es que las tools de dominio no llevan campos identificadores de tenant/hotel/huésped — esos valores vienen del `ToolContext` resuelto en servidor a partir del JWT de sesión. Un auditor que proponga "validar mejor los argumentos" sin verificar primero si el campo existe en el esquema de la tool no leyó el código. Lo que sí hay que vigilar es que ninguna tool nueva rompa esa regla, y que el motor de precio/impuesto/disponibilidad sea de verdad un servicio tipado, no una llamada oculta al LLM en algún camino secundario (cancelaciones, ajustes manuales, upsell).

**Anclas:** 8+ si ninguna tool acepta identificadores de tenant/hotel/huésped ni cifras de precio/tarifa del modelo, todas las tools de efecto externo tienen `needs_approval` correcto, y el camino con fallback de proveedor tiene prueba. 6 si la regla se respeta pero falta prueba unitaria que la vigile (el día que alguien la rompa, nadie se entera hasta producción). 4 o menos si el modelo puede influir en qué tarifa se cobra, a qué hotel pertenece una fila, o ejecutar una acción irreversible sin aprobación.

---

## 5 · Seguridad y aislamiento multi-tenant

**Dueño de** autenticación, autorización, secretos, RLS y grants, firma de webhooks (WhatsApp, PMS, pasarela de pago), límites de tasa, bóveda de identidad, y — el eje propio de este producto frente a Likida — que **ningún dato, tarifa o mensaje cruce de un hotel a otro**.

**Dónde:** `apps/api/` (middleware de sesión, `set_config` de claims), `packages/db/` (políticas RLS, `is_hotel_staff`), `packages/agent-core/` (aislamiento de contexto por conversación), rutas de webhook de cada conector en `packages/mcp-servers/*` (ADR-007), bóveda de identidad (GOB-044).

**Requisitos-ancla (REQ-*):** REQ-TEN-001, REQ-AGT-022, REQ-INT-014, REQ-SEG-012, REQ-SEG-013, REQ-SEG-014.

**Qué cuenta:** un secreto (token de PMS, credencial de pasarela) con fallback derivado de otro secreto cuando falta; autorización que descansa en una sola capa (un matcher de proxy es una capa, no dos — patrón exacto que Likida documenta en `proxy.ts`, §3.7, y que aquí aplica igual a `apps/api/` vs. `apps/web/`); un `GRANT` implícito que el aislamiento por `tenant_id` (`org_id`) no cierra y que permite a un usuario de la `org A` leer disponibilidad, tarifas o folio de un hotel de la `org B`, o que permite a un usuario con rol solo en `hotel A` leer un `hotel B` de su misma `org` sin que el scope `hotel_id` lo bloquee; un webhook de WhatsApp o del PMS sin verificación HMAC o sin dedupe por `source.event_id` (GOB-042); una URL firmada (comprobante, factura) con TTL más largo del necesario; una imagen de identificación de huésped que sale de la bóveda aislada hacia un log o un prompt sin redactar (GOB-044); un CVE con camino real de explotación en esta app — y si no lo hay, decirlo y descartarlo por escrito.

**Herramientas:** `review` para SQL, fronteras de confianza y efectos escondidos en condicionales. `auditor-permisos` si la ronda toca configuración de permisos o hooks. `npm audit` como insumo, nunca como veredicto.

**Anclas:** 8+ si toda ruta privilegiada tiene dos capas independientes de autorización, ningún secreto tiene fallback silencioso, y una prueba adversarial de cruce de tenant (hotel A leyendo/escribiendo hotel B) falla al ataque. 7 si el diseño es correcto y las capas son una sola en algún punto (p. ej. rutas API sin segunda capa por página). 4 o menos si existe un camino de acceso sin autenticar a datos de un hotel, o un dato de huésped sale de la bóveda sin redactar.

---

## 6 · Cumplimiento fiscal (CFDI 4.0 hotelero / ISH / IVA)

**Dueño de** que las cifras que el producto imprime y afirma coincidan con la norma vigente del hospedaje: CFDI 4.0 (complemento de hospedaje si aplica), Impuesto Sobre Hospedaje (ISH, estatal, tasa distinta por entidad), IVA acreditable, retenciones, plazos de timbrado.

**Dónde:** `packages/domain-hotel/` (motor de folio/impuestos, night audit — ADR-005/H16), contrato `CfdiPort` en `packages/mcp-servers/cfdi/` (ADR-007, **pendiente de credenciales**), leyendas y desglose que el folio/factura muestra al huésped.

**Requisitos-ancla (REQ-*):** REQ-BO-001, REQ-BO-002, REQ-BO-007, REQ-GOB-011.

**Cómo se audita, y es distinto a los demás rubros:** si existen fichas de norma versionadas (equivalente a `normas/*.yaml` de Likida) para ISH por estado y para el complemento de hospedaje del CFDI 4.0, se abre la ficha, se lee el texto transcrito, y se compara contra la línea de código que la implementa. Si no existen todavía (fase temprana), se anota explícitamente **"sin ficha de norma versionada — no verificable contra fuente primaria en esta ronda"**, nunca se asume que el cálculo está bien porque el código se ve razonable.

**Qué cuenta:** aplicar la tasa de ISH del estado equivocado a una reserva (el ISH es estatal, no federal — una tarifa fija a nivel código para todos los hoteles es un hallazgo aunque el número "se vea bien" para un caso de prueba); IVA calculado sobre una base que ya incluye ISH o viceversa; un complemento de hospedaje del CFDI que omite un campo requerido y el timbrado pasa igual porque el PAC (o su fixture, ADR-007) no lo valida; una leyenda impresa en el folio que cita una tasa o un artículo que no corresponde; night audit que cierra el día con una cifra fiscal distinta a la que el folio mostró al huésped.

**Peso:** un error aquí sale impreso en el folio o en el CFDI que un huésped o su empresa presenta ante el SAT. Vale más que un bug de UI aunque el diff sea de una línea.

**Anclas:** 8+ si cada cifra fiscal impresa rastrea a una ficha de norma verificada contra fuente primaria (o, a falta de ficha, a una prueba con el caso documentado de la norma) y hay prueba automatizada del cálculo. 6 si la lógica es correcta por lectura y la trazabilidad a la norma es informal o falta la ficha. 3 o menos si el producto imprime o timbra una cifra fiscal equivocada.

---

## 7 · Cumplimiento legal y privacidad (LFPDPPP 2025, datos de huésped, ARCO)

**Dueño de** datos personales del huésped: consentimiento, aviso de privacidad, transferencias a terceros (incluye toda salida hacia un LLM externo), retención (identificación con TTL ≤30 días, GOB-044), custodia en la bóveda aislada, derechos ARCO.

**Dónde:** el `disclosure engine` (GOB-015/034), la bóveda de identidad (GOB-044, aislada del resto de la lógica según ADR-005), toda ruta que envíe datos de huésped a un proveedor de LLM (`packages/agent-core/`), el flujo de exportación del registro de huéspedes hacia autoridades (decisión reservada al fundador, GOB-052).

**Requisitos-ancla (REQ-*):** REQ-SEG-001, REQ-SEG-002, REQ-SEG-003, REQ-SEG-004, REQ-SEG-014.

**Qué cuenta:** mandar la foto de una identificación o un dato de huésped a un modelo externo sin que el aviso de privacidad lo cubra; un consentimiento implícito donde la LFPDPPP 2025 pide expreso; retención de una imagen de identificación más allá de 30 días sin purga automática verificable; ausencia de camino real para ejercer derechos ARCO; exportación del registro de huéspedes a una autoridad sin la aprobación humana que GOB-052 reserva al fundador; razonar con la ley anterior a marzo 2025 en cualquier documento o decisión (es un hallazgo en sí mismo, igual que en el rubro equivalente de Likida).

**Por qué es rubro aparte de fiscal:** un error fiscal le cuesta dinero al hotel y se corrige con una nota de crédito. Un error legal es responsabilidad de Atiende Hoteles frente a la autoridad y frente al huésped titular del dato, y no se corrige con dinero.

**Anclas:** 8+ si cada salida de datos personales de huésped tiene su base en el aviso, la bóveda aislada tiene purga automática verificada y hay camino de revocación. 6 si el aviso existe y cubre lo principal con huecos anotados. 3 o menos si hay transferencia de datos personales de huésped sin cobertura, o retención de identificación más allá de 30 días sin purga.

---

## 8 · Arquitectura y mantenibilidad

**Dueño de** dónde vive cada cosa, cuántas copias hay de la misma verdad, qué tan caro es cambiar algo, y qué se va a desincronizar la próxima vez.

**Dónde:** todo `apps/` y `packages/`, con foco en las fronteras que ADR-001/004/005/007 fijan: ¿todo acceso a datos de negocio pasa por `packages/db/` y respeta RLS? ¿`packages/domain-hotel/` (motor de precio/impuesto) sigue siendo puro y determinista, sin I/O ni llamada a LLM? ¿`pms_mirror` sigue siendo estrictamente de solo lectura desde la lógica de negocio (GOB-016, ADR-005)? ¿cuántos lugares definen el mismo mapa de estados de reserva o de habitación?

**Requisitos-ancla (REQ-*):** REQ-GOB-013, REQ-AGT-018, REQ-REV-001.

**Qué cuenta:** dos literales que dicen lo mismo y ya divergieron (un mapa de estados de `reservation` en `apps/web/` y otro en `packages/domain-hotel/` que ya no coinciden es el ejemplo canónico); acceso a datos que se salta `packages/db/` y llama directo al pool de Postgres; una función del motor de precios que empezó a hacer I/O (llamar al PMS a media evaluación); un módulo de negocio que escribe en `pms_mirror` en vez de solo leerlo; un conector nuevo con `if provider === X` fuera del registro único (GOB-059); una dependencia que apunta al revés entre paquetes del monorepo.

**La regla del rubro:** una advertencia de la ronda anterior que volvió a ocurrir no es una advertencia, es un hallazgo, y baja la nota aunque no haya bug visible hoy. Es la única forma de que la deuda cobre factura antes de que la cobre el hotel cliente.

**Anclas:** 8+ si cada verdad vive en un lugar y las fronteras (`domain-hotel` puro, `pms_mirror` solo-lectura, registro único de conectores) se respetan sin excepción. 6 si las fronteras existen y hay dos o tres fugas conocidas. 4 o menos si la misma lógica de dinero o de disponibilidad vive en más de un archivo.

---

## 9 · Pruebas

**Dueño de** qué está cubierto, qué no, y si las pruebas fallarían de verdad si alguien revirtiera el arreglo que dicen proteger.

**Dónde:** `tests/unit/` (Vitest + PGlite), `tests/integration/` (Vitest + `embedded-postgres`, ADR-003/009), `tests/e2e/` (Playwright, recorrido login → reserva → check-in → cargo a folio → check-out), `tests/adversarial/` (cruce de tenant, escalada de rol, HMAC inválido, doble-cobro), `.github/workflows/ci.yml`.

**Requisitos-ancla (REQ-*):** REQ-QA-001, REQ-QA-002, REQ-QA-003, REQ-QA-004, REQ-QA-005, REQ-TEN-001.

**Qué cuenta:** el cálculo de tarifa/impuesto probado y la **escritura** de disponibilidad/folio/pago sin arnés de concurrencia real (probar solo contra PGlite, que serializa según ADR-003, no cuenta como prueba de concurrencia); una prueba que pasa aunque se rompa la función (assertion floja, mock que devuelve lo que la prueba quiere oír); una prueba adversarial de aislamiento de tenant que en realidad nunca ejecuta el ataque (falta el segundo cliente/segunda sesión); una prueba intermitente que depende de la hora o de la red; una regresión ya corregida en producción sin prueba que la ancle; `tests/e2e/` que corre contra mocks del PMS/pasarela en vez del contrato real cuando el contrato ya existe (ADR-007).

**El chequeo que distingue este rubro:** tomar dos o tres pruebas de dinero o de disponibilidad y romper a propósito la función que cubren, mentalmente o de verdad. Si la prueba seguiría verde, es decoración. Reportar cuáles.

**Anclas:** 8+ si cada arreglo histórico tiene prueba anclada con el ID del hallazgo, las pruebas de concurrencia corren contra `embedded-postgres` (no solo PGlite) y el CI corre en cada push. 6 si la suite es grande y verde pero hay zonas de dinero o disponibilidad sin arnés de concurrencia real. 4 o menos si la suite pasa con la función rota.

---

## 10 · Operabilidad y DX

**Dueño de** qué pasa cuando algo se rompe en producción: ¿alguien se entera?, ¿en cuánto tiempo?, ¿con qué información?, ¿y se puede reproducir localmente sin credenciales de PMS/pasarela reales?

**Dónde:** logs estructurados con `tenant_id`/`hotel_id`/`reservation_id`/`request_id`/`run_id` de agente (ADR-008), `/health` y `/health/db`, runbooks ("brecha de seguridad", "caída de conector externo"), `.github/workflows/ci.yml`, backups (`pg_dump` contra `embedded-postgres`/Supabase remoto), `.env.example`.

**Requisitos-ancla (REQ-*):** REQ-OBS-001, REQ-OBS-002, REQ-AGT-006.

**Qué cuenta:** un log de fallo que no dice **cuál** reserva o folio falló; una alerta ausente en el camino del dinero (cobro, cambio de tarifa); un error del conector PMS que se traga y devuelve 200 a WhatsApp; una variable de entorno que falta (p. ej. `ANTHROPIC_API_KEY`) y el sistema arranca igual simulando una respuesta de agente en vez de entrar en el "modo sin credenciales honesto" que ADR-006 exige; un `setup` que no deja el proyecto corriendo en una máquina limpia sin Docker (contradice ADR-003); PII en una traza persistida sin redactar (GOB-035).

**La pregunta que ordena el rubro:** si esto revienta a las 3 de la mañana con un huésped en el mostrador, ¿qué tengo a la mañana siguiente para saber qué pasó? Si la respuesta es "nada", la nota no pasa de 5 por más limpio que esté el código.

**Anclas:** 8+ si cada fallo del camino del dinero o de la disponibilidad genera alerta con identificador suficiente para reconstruirlo, y `/health`/`/health/db` distinguen proceso vivo de base caída. 6 si hay logs pero nadie los mira y el CI existe. 4 o menos si un fallo en producción es invisible o el sistema arranca "bien" sin las credenciales que necesita.

---

## 11 · Rendimiento y costo (incl. costo LLM por hotel)

**Dueño de** el peor caso, no el promedio: tiempos contra los límites reales de la plataforma, tokens por interacción, dinero por operación, consultas por request, y — a diferencia de Likida, que audita costo por *corrida* — costo LLM **por hotel** cuando varios hoteles comparten el mismo despliegue.

**Dónde:** `packages/agent-core/` (presupuesto de tiempo/tokens por invocación, contabilidad de costo por modelo real, ADR-006/§2.3/§2.6 de Likida portado), rutas de `apps/api/` con `maxDuration`, `packages/db/` (N+1 en consultas de disponibilidad/calendario), integraciones de imagen (identificación de huésped, comprobantes) sin redimensionar.

**Requisitos-ancla (REQ-*):** REQ-AGT-005, REQ-AGT-016, REQ-AGT-020.

**Qué cuenta:** un presupuesto de tiempo que no cabe en su propio límite de plataforma (peor caso sumado de mutex+barrera+agente+cierre contra el timeout real); un costo de LLM que se atribuye al hotel equivocado cuando el fallback cambia de modelo a mitad de una corrida (mismo bug que Likida corrigió explícitamente en `openrouter.ts`, §2.6); una consulta de disponibilidad dentro de un bucle por noche/habitación en vez de una sola consulta agregada; un modelo caro (Opus/Sonnet alto razonamiento) donde uno barato (Haiku) bastaba para enrutamiento de idioma o intención; tokens gastados en contexto que el modelo no usa porque el prefijo cacheable no llega al mínimo que GOB-033 exige; una imagen de identificación o comprobante que se manda al modelo sin redimensionar.

**Cómo se audita:** sumar los peores casos de la cadena a mano y comparar contra el límite escrito. No estimar "se siente rápido" — el número contra el número. Para costo por hotel: verificar que la contabilidad se agrupa por `tenant_id`, no solo por corrida global.

**Anclas:** 8+ si el peor caso sumado cabe con margen, el costo por operación está medido, y el costo LLM se puede desglosar por hotel. 6 si el promedio es bueno y el peor caso está apenas dentro, o el costo se mide global sin desglose por hotel. 4 o menos si el peor caso excede el límite y falla callado, o el costo LLM de un hotel se le puede facturar a otro.

---

## 12 · Modelo de datos y esquema (reservas/disponibilidad/folio)

**Dueño de** si la base puede guardar un estado imposible: restricciones, unicidad, tipos, nulabilidad, RLS, migraciones y su reversibilidad, sobre las entidades centrales de ADR-005 (`reservation`, `availability`, `rate`, `folio`, `charge`, `payment`, `guest`, `audit_log`).

**Dónde:** `packages/db/` (migraciones `.sql` versionadas, políticas RLS, `supabase/tests/` o su equivalente pgTAP/vitest), tipos compartidos en `packages/domain-hotel/`.

**Requisitos-ancla (REQ-*):** REQ-TEN-001, REQ-REC-003, REQ-REC-004, REQ-GOB-010, REQ-GOB-011.

**Qué cuenta:** un dominio sin `CHECK` que acepta una tarifa negativa o un estado de reserva inventado (algo fuera de `cotizada|confirmada|check_in|en_estancia|check_out|cerrada|cancelada|no_show`); falta de `UNIQUE` donde la lógica asume unicidad — **overbooking** es exactamente este hallazgo: dos reservas confirmadas para la misma habitación la misma noche porque la base no lo impide, solo la aplicación cree evitarlo; falta de constraint de idempotencia `(tenant_id, idempotency_key)` que permite **doble cargo en el mismo folio**; un tipo de TypeScript más estricto que la columna real (la forma más común de mentirse); dinero tipado `float` en vez de `numeric(12,2)` (GOB-013); una transición de estado de `reservation` implementada como `UPDATE` destructivo en vez de evento append-only (ADR-005 exige lo segundo); RLS que se apoya en que la aplicación se porte bien en vez de en la política misma — la prueba real es si un script, una consola directa a Postgres o un bug futuro que se salte `apps/api/` puede leer o escribir una fila de la `org B` estando autenticado como la `org A` (aislamiento de tenant), o una fila de `hotel B` estando autenticado con rol solo en `hotel A` de la misma `org` (scope de hotel).

**El chequeo que distingue el rubro:** para cada invariante que el código asume ("nunca hay dos reservas confirmadas en la misma habitación la misma noche", "un folio no se cobra dos veces", "un hotel no ve datos de otro"), preguntar si la base la impone con un constraint o una política, no si la aplicación la respeta hoy. Si la respuesta es "la aplicación se encarga", es un hallazgo.

**Anclas:** 8+ si cada invariante del código (unicidad de reserva por habitación/noche, idempotencia de cargo, aislamiento por tenant) tiene su restricción o política en la base, verificada con una prueba que intenta romperla. 7 si las unicidades críticas están y faltan los `CHECK` de dominio (montos, estados). 4 o menos si la base acepta un overbooking, un doble cargo, o una fuga de datos entre hoteles que el producto no sabe manejar.

---

## La escala 0–10

Cinco es "funciona en el camino feliz y los bordes son suposiciones". Cada punto arriba cuesta trabajo real y verificable; cada punto abajo describe un daño concreto, no una incomodidad.

- **9–10** — reservado. Solo si un experto externo del rubro no encontraría nada material. Casi nunca se otorga y hay que justificar por qué esta vez sí.
- **8** — sólido con red: pruebas, restricciones o alertas que sostienen lo que el código promete.
- **6–7** — correcto donde importa, sin red en la periferia. Es donde vive un pre-lanzamiento honesto.
- **5** — el camino feliz funciona; los bordes son fe.
- **3–4** — existe un camino donde el producto hace algo mal (overbooking, doble cargo, mensaje al huésped equivocado, tarifa inventada por el LLM, fuga entre hoteles) y nadie se entera.
- **0–2** — el rubro no está atendido.

**Mover una nota exige una razón escrita de una de estas tres formas**, porque son las únicas que distinguen señal de ruido:

1. *Se atacó y subió* — hay commits de esta ronda que cerraron hallazgos del rubro.
2. *Deuda que cobró factura* — algo marcado como advertencia antes ya ocurrió.
3. *Mirada más profunda* — el código no cambió, la nota anterior estaba inflada. **Decirlo así**, con esas palabras: no es que empeorara, es que se vio mejor.

Sin una de las tres, la nota se queda igual. Una nota que se mueve sola es ruido, y el ruido diario destruye la utilidad de la serie histórica.

## La regla que no cambia entre rubros

**Un hallazgo tiene cuatro cosas, o no existe:**

1. `archivo:línea` exacto — abierto y leído, no inferido de un nombre.
2. Escenario de falla concreto con valores: **entra esto → sale esto mal**. No "podría fallar bajo carga"; sí, por ejemplo, "con dos requests simultáneos reservando la habitación 204 la noche del 2026-12-24, ambos leen `availability=1` antes de que el primero decremente, y `apps/api/reservas.ts:140` no adquiere `pg_advisory_xact_lock` antes del `INSERT` — las dos reservas quedan `confirmada`, la habitación se vende dos veces".
3. Consecuencia para alguien real: el huésped, el gerente, el SAT, el hotel cliente, u otro hotel del mismo despliegue si el hallazgo es de fuga entre tenants.
4. Severidad: CRÍTICO (dinero mal, dato personal de huésped expuesto, overbooking, o fuga entre hoteles) · ALTO (falla silenciosa o efecto duplicado) · MEDIO (se degrada y se nota) · BAJO (deuda que va a cobrar factura).
