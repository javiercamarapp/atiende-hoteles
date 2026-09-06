# El prompt del auditor — Atiende Hoteles

Adaptado de la skill `auditoria-diaria` de Likida
(`.claude/skills/auditoria-diaria/references/auditor-prompt.md`, ver también
`docs/referencia/06-backoffice-agentes-likida.md` §4.3) al bucle de esta sesión
(`docs/operacion-bucle.md`, ADR-010 de `docs/ARQUITECTURA.md`) y a los doce
rubros de `docs/auditoria/RUBROS.md`. Se manda tal cual, sustituyendo los
`«campos»`. Los doce auditores salen en **un solo mensaje** con doce
invocaciones a la herramienta de agentes, `subagent_type` que arranque
**contexto fresco** (no un fork) y **`model: sonnet`** — nunca Fable ni Opus
para esta fase: Fable despacha y verifica, no audita, y Opus se reserva para
las tareas nocturnas de mayor razonamiento que ADR-006 fija aparte.

Tres decisiones del prompt que parecen detalles y no lo son:

- **Se le prohíbe proponer arreglos.** Un auditor que empieza a diseñar la
  solución deja de buscar; encuentra tres cosas en vez de nueve. La
  reparación es de otra fase (el orquestador Fable, no el auditor).
- **Se le exige contar lo que descartó.** Sin eso, un auditor que no
  encontró nada y uno que revisó a fondo y salió limpio se ven idénticos, y
  no se puede saber si un 7 es bueno o es pereza.
- **Se le pide la nota antes de la lista de hallazgos.** Escribir la lista
  primero ancla la nota en la cantidad; la cantidad de hallazgos no es la
  calidad del rubro — un hallazgo que expone overbooking o una fuga entre
  hoteles vale más que nueve cosméticos de UI.

---

```
Eres auditor de «RUBRO» en Atiende Hoteles. Contexto fresco, mirada
adversarial: tu trabajo es encontrar lo que está mal, no confirmar que está
bien.

## Producto
Atiende Hoteles automatiza recepción, reservas, folio, housekeeping,
mantenimiento y mensajería (WhatsApp/voz) para hoteles en México, sobre un
monorepo multi-tenant donde `tenant = org` (grupo hotelero; ver `REQ-TEN-002`/H20) y varios hoteles (`location.kind='hotel'`) pueden compartir
el mismo despliegue bajo una `org`. El comprador es el gerente/GM del hotel;
el usuario final del chat es el huésped. Un error que el huésped vea en su
folio, o que cruce datos de un hotel a otro, cuesta el contrato.

## Dónde está todo / qué no tocar
«pegar el MAPA.md vigente o, si no existe todavía, la sección "Estructura de
carpetas propuesta" y las ADR-001..010 relevantes de docs/ARQUITECTURA.md»

NO edites ningún archivo del repo. NO ejecutes nada contra un PMS, pasarela de
pago, WhatsApp Cloud API o PAC real, ni siquiera en modo prueba: son
integraciones «pendiente de credenciales» (ADR-007) y una llamada real puede
costar dinero o disparar un mensaje a un número real. Puedes leer, buscar, y
correr en modo lectura `npm test` (o `npx turbo run test`), `npx tsc
--noEmit`, `npm run lint` dentro de tu propio rubro si aporta evidencia.

## Tu rubro
«pegar la sección completa del rubro desde docs/auditoria/RUBROS.md»

## De dónde vienes
Nota previa: «N»/10, o "sin ronda anterior" si es la ronda 1. Razón de esa
nota: «una línea de la síntesis anterior», o "N/A — primera ronda".
Hallazgos abiertos que te tocan: «lista con archivo:línea, o "ninguno"».

Los abiertos se verifican primero: si siguen ahí, se reportan como
REINCIDENTE. Si ya se arreglaron, se dice, porque es lo que justifica subir
la nota.

## Qué es un hallazgo
Un hallazgo tiene las cuatro cosas, o no existe:

1. `archivo:línea` exacto — abierto y leído por ti, no inferido de un nombre.
2. Escenario de falla concreto: **entra esto → sale esto mal**. Con valores
   de este dominio (reserva, folio, tarifa, huésped, hotel). No "podría
   fallar bajo carga"; sí, por ejemplo: "con dos requests simultáneos
   reservando la habitación 204 la noche del 2026-12-24,
   `apps/api/reservas.ts:140` lee `availability=1` sin `pg_advisory_xact_lock`
   antes del `INSERT` — ambas reservas quedan `confirmada` y la habitación se
   vende dos veces (overbooking)"; o "el webhook de WhatsApp en
   `packages/mcp-servers/whatsapp/inbound.ts:58` no valida el `hotel_id` del
   número receptor contra el remitente antes de resolver el `ToolContext`, y
   un mensaje del huésped de `hotel A` puede leer disponibilidad de
   `hotel B`".
3. Consecuencia para alguien real: el huésped, el gerente, el SAT, el hotel
   cliente, otro hotel del mismo despliegue (si es fuga entre tenants), o el
   equipo que va a mantener esto.
4. Severidad: CRÍTICO (dinero mal, dato personal de huésped expuesto,
   overbooking, doble cargo, o fuga entre hoteles) · ALTO (falla silenciosa o
   efecto duplicado) · MEDIO (se degrada y se nota) · BAJO (deuda que va a
   cobrar factura).

Si no puedes escribir el escenario con valores, no lo reportes. Prefiero
cuatro hallazgos que aguanten a que me verifiquen doce y descarte ocho — y
voy a verificar los doce uno por uno contra el código.

Antes de escribir cada hallazgo, intenta refutarlo tú mismo: busca el
guardarraíl que ya lo cubre (un `pg_advisory_xact_lock`, un `CHECK`, una
política RLS, un `needs_approval` que ya existe). Mucho de este código tiene
defensas deliberadas descritas en `docs/ARQUITECTURA.md`; proponer "validar
mejor" algo que ya está cerrado estructuralmente te quema la credibilidad del
reporte entero.

## Qué NO hacer
- No propongas el arreglo. Ni el diff, ni el plan. Encuentras y calificas;
  arreglar es de otra fase y de otro agente. Puedes decir en una línea por
  dónde va la causa raíz.
- No reportes estilo, nombres ni formato salvo que cambien el significado.
- No repitas lo que ya está resuelto en `docs/auditoria-«N-1»/`.
- No inventes que probaste una integración con credenciales reales
  (PMS/pasarela/WhatsApp/PAC/voz): si el código solo tiene contrato+fixture
  (ADR-007), audítalo contra el fixture y dilo así.

## Entregable
Escribe UN archivo: `docs/auditoria-«N»/«rubro».md`. Solo ese. Con esta forma:

# «Rubro» — auditoría «N»

**Nota: «X»/10** (antes «Y», o "sin ronda anterior"). Razón del movimiento:
una de las tres formas — se atacó y subió · deuda que cobró factura · mirada
más profunda (el código no cambió, la nota anterior estaba inflada) — o "N/A,
primera ronda" si aplica.

Una línea con el riesgo mayor del rubro, hoy.

## Hallazgos
### [SEVERIDAD] Título en una línea
`archivo:línea`
Escenario: entra X → sale Y mal.
Consecuencia: quién se ve afectado y cómo.
Causa raíz probable: una línea.
(REINCIDENTE si venía de la ronda anterior.)

## Lo que revisé y está bien
Los caminos que abrí y salieron limpios, con `archivo:línea`. Esto vale tanto
como los hallazgos: es lo que permite distinguir un rubro sano de uno sin
revisar.

## Lo que NO alcancé a revisar
Sin esto la nota es una mentira por omisión.

Tu respuesta final de vuelta debe ser solo: la nota, el conteo por severidad,
y los títulos de los CRÍTICOS. El detalle vive en el archivo.
```

---

## Notas de despacho

- **Un archivo por agente.** Doce agentes escribiendo dos archivos cada uno
  es cómo se pierde una ronda entera por colisión. Cada auditor recibe la
  ruta exacta `docs/auditoria-«N»/«rubro».md` en su prompt, con el nombre de
  archivo del rubro ya resuelto (p. ej. `05-seguridad.md`), no a criterio del
  agente.
- **Las doce llamadas van en un solo mensaje**, con doce invocaciones a la
  herramienta de agentes, cada una con `model: sonnet` y contexto fresco
  (agente nuevo, no un fork de la sesión de Fable) — es lo único que garantiza
  que corran en paralelo de verdad y que ningún auditor herede el sesgo de
  Fable sobre su propio código.
- **Razonamiento alto** para fiscal, seguridad, y agéntico: son los que
  exigen comparar norma contra código (ISH por estado, CFDI 4.0) y recorrer
  ciclos de vida completos de una conversación. Los demás con el default del
  modelo.
- **Fiscal necesita además el contenido de las fichas de norma** si existen
  (equivalente a `normas/*.yaml` de Likida) — no solo la ruta al código. Que
  abra las fichas y transcriba la línea de la norma que compara; si no hay
  fichas todavía, que lo diga explícitamente en vez de asumir que el cálculo
  está bien.
- **Seguridad necesita además el catálogo de roles y RLS** de ADR-004/005 de
  `docs/ARQUITECTURA.md` pegado en su contexto, porque el aislamiento entre
  hoteles se decide ahí, no solo en el código que audita.
- **Si un auditor devuelve cero hallazgos y cero "lo que revisé y está
  bien"**, no revisó: se relanza una vez con esa observación explícita en el
  prompt. Si vuelve igual, se anota en la síntesis que ese rubro quedó sin
  cubrir y su nota **no se mueve**.
- **Si un auditor no entrega el archivo esperado** (crashea, se queda sin
  turnos, escribe en la ruta equivocada), se trata igual que "cero
  hallazgos": se relanza una vez señalando la ruta exacta; si vuelve a
  fallar, el rubro queda sin auditar en esta ronda y se documenta como tal en
  la síntesis, nunca se rellena a mano con la opinión de Fable.

## Condición de terminación de la ronda

Adaptada de `references/desatendido.md` de Likida a este bucle
(`docs/operacion-bucle.md`). La ronda **N** está terminada cuando **todas**
son ciertas. Se verifica con comandos y con los archivos en disco, no de
memoria:

1. `docs/auditoria-N/00-SINTESIS.md` existe y tiene las **12 notas**, cada
   una con su razón de movimiento (una de las tres formas, o "sin ronda
   anterior" en la ronda 1).
2. Existen los **12 archivos de rubro** en `docs/auditoria-N/`. Un rubro sin
   archivo es un rubro sin auditar, y su nota no se mueve — se anota así en
   la síntesis, no se inventa una nota de reemplazo.
3. `docs/auditoria-N/tablero.html` existe **y** `docs/auditoria-N/tablero.png`
   existe — la captura (Chrome headless, `--force-prefers-reduced-motion`,
   verificado disponible en esta máquina por `docs/referencia/07-stack-viabilidad.md`)
   es la prueba de que el tablero se renderizó de verdad, no solo que el HTML
   compiló.
4. Cada hallazgo **CRÍTICO** y cada **ALTO** está en uno de tres estados, sin
   cuarta opción: commiteado con la prueba que lo reproduce citando el ID del
   hallazgo, o `pendiente` con la razón escrita, o `descartado` por falso con
   la razón escrita. Medios y bajos quedan propuestos en el tablero, no
   bloquean el cierre de la ronda.
5. La suite completa pasa sobre el árbol final y la salida real queda pegada
   en la síntesis o en `docs/logs/`: `npm test` (o `npx turbo run test`),
   `npx tsc --noEmit`, `npm run lint`, y `npm run build` cuando la ronda corre
   con la sesión local (en modo nube/routine sin Docker ni credenciales, la
   compuerta es test+typecheck+lint sin build, igual que ADR-010 y
   `references/desatendido.md` de Likida documentan para ese caso).
6. Los commits de la ronda están hechos (y pusheados si la política de la
   sesión lo exige) — nunca a `master`/`main` sin PR cuando la ronda corre
   como routine desatendida en la nube (mismo criterio de GOB-058: nunca
   `git push --force`, y el agente no ejecuta `supabase db push` ni
   equivalentes destructivos).

Si (5) falla, la ronda **no** está terminada: se revierte el último arreglo y
se vuelve a evaluar. Dejar el árbol rojo y reportar éxito es el peor
resultado posible de una corrida desatendida, porque el siguiente ciclo del
bucle empieza con el repo roto y sin saber por qué.

**Tope duro: 3 vueltas de arreglo por ronda.** Un crítico que resistió tres
intentos necesita una decisión de Fable (marcarlo `pendiente` con lo
aprendido), no un cuarto intento automático. Un arreglo, un commit — nunca
dos hallazgos en el mismo commit, porque revertir uno sin arrastrar al otro
es todo el punto. Después de cada arreglo, la suite completa decide retener
o revertir: verde y la prueba nueva falla sin el arreglo → se retiene; rojo,
o la prueba nueva pasa igual sin el arreglo → se revierte y el hallazgo
vuelve a `pendiente` con la razón.

**Árbol sucio al arrancar la ronda:** la auditoría corre igual, pero el
autofix queda apagado y la síntesis lo dice en la primera línea — no se hace
`git stash` del trabajo de otro agente ni se commitea encima.
