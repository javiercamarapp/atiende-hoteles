# Contrato del webhook de tools — qué está verificado y qué no

ADR-006/007 ("esqueleto honesto"): esta página existe para que nadie asuma que este
webhook fue probado contra ElevenLabs real solo porque tiene tests. Léela antes de la
primera llamada telefónica real.

## 1. Lo que SÍ está verificado (100%, con pruebas reproducibles)

- El código que ATIENDE la petición HTTP (`apps/api/src/routes/vozElevenlabs.ts`) corre
  de verdad contra una base de datos Postgres real (`embedded-postgres`, no un mock) y
  ejecuta las MISMAS tools de dominio real (`packages/agent-core/src/tools/*.ts`) que ya
  usa el resto del producto — no hay una versión "de juguete" separada para voz.
- Autenticación por secreto (correcto/ausente/incorrecto/de otro hotel), aislamiento
  entre hoteles, respeto al gate `shadow`/`propone` del hotel, validación de entrada, y
  el flujo completo de `enviar_mensaje_whatsapp_plantilla` (pendiente → aprobación
  humana vía `/aprobaciones/:id/decidir` → mensaje real creado): todo esto tiene un test
  de integración real que falla si se rompe —
  `tests/integration/api/voz-elevenlabs.spec.ts` (16 casos, corre contra una BD real).
- `scripts/voz-elevenlabs-webhook-simulator.ts` ejercita el mismo código contra un
  servidor de este repo corriendo de verdad (`npm run dev`), simulando ambas formas de
  cuerpo documentadas más abajo.

Lo anterior prueba que **nuestro lado** (el servidor que ElevenLabs va a llamar) hace
exactamente lo que dice que hace. Es la mitad que SÍ se puede probar sin cuenta de
ElevenLabs, porque en esta dirección nosotros somos el servidor, no el cliente.

## 2. Lo que NO está verificado (honesto, sin cuenta real de ElevenLabs en este entorno)

### 2.1 Forma exacta del cuerpo que ElevenLabs manda de verdad

Se encontraron DOS descripciones distintas, ninguna confirmable sin una cuenta real:

- **Forma "plana"** — el cuerpo ES literalmente el `request_body_schema` declarado en
  la tool (ej. `{ "roomCode": "204", "priority": "alta" }`). Este es el patrón que usa
  DE VERDAD `atiende-restaurantes` (un agente real, funcionando, según el encargo de
  esta tarea) — sus funciones (`create-order`, `cotizar-pedido`, etc.) leen el cuerpo
  directo, sin ningún envoltorio, incluyendo variables de sistema inyectadas como
  campos del propio cuerpo (`conversation_id` como campo plano, con
  `dynamic_variable_placeholders` configurado en la tool).
- **Forma "envuelta"** — documentada por la skill empaquetada `agents` de este entorno
  (sección "Webhook Request Format"): `{ "tool_call_id": "...", "tool_name": "...",
  "parameters": { ...los campos reales... }, "conversation_id": "..." }`.

**Decisión tomada:** el webhook de este repo acepta CUALQUIERA de las dos formas
(`extractToolParams()` en `vozElevenlabs.ts`) — si el cuerpo trae un campo `parameters`
que es un objeto (no arreglo) Y además trae `tool_name`/`tool_call_id` (la firma real
del sobre "envuelto"), se usa `parameters` como los argumentos reales de la tool; si no,
se usa el cuerpo completo. Esto es una decisión defensiva para maximizar la probabilidad
de funcionar la primera vez, **no** una confirmación de cuál de las dos usa ElevenLabs
hoy para este tipo de tool. La primera llamada de prueba real (ver
`runbook-pasos-manuales.md` paso 6) debe revisar los logs del servidor para confirmar
cuál llegó, y este documento debe actualizarse con el resultado.

### 2.2 Forma exacta de la respuesta que ElevenLabs espera

La misma sección de la skill documenta `{ "result": "..." }` o `{ "result": {...} }`
como la respuesta esperada. Este webhook siempre responde envuelto en `{ "result":
{...} }` en éxito (y `{ "error": "..." }` con el status HTTP correspondiente en
fallo, igual que atiende-restaurantes) — tampoco se pudo confirmar si ElevenLabs de
verdad exige la llave `result` o simplemente relee cualquier JSON/texto de la respuesta
como el resultado de la tool para dárselo al modelo.

### 2.3 Variables de sistema de telefonía entrante (número de quien llama)

No se pudo confirmar el nombre exacto de la variable dinámica de sistema (si existe)
que expondría el número de quien llama en una llamada telefónica entrante real
(candidatos plausibles por convención de nombres de ElevenLabs, `system__caller_id` o
similar, pero **ninguno se verificó contra una cuenta real** en este entorno). Esto es
relevante porque, si existiera y fuera confiable, permitiría en el futuro construir una
tool de solo-lectura segura ("¿tengo una tarea/ticket abierto?") verificando que quien
pregunta es el mismo teléfono del huésped — ver `README.md` §4 para por qué esa tool NO
se construyó en esta tarea.

### 2.4 Comportamiento real de latencia/reintentos/timeouts de ElevenLabs

No verificado. El webhook responde rápido en todos los casos (inserts simples, sin
llamadas a proveedores externos reales) — housekeeping/mantenimiento/ticket de
huésped/ROI deberían responder en milisegundos contra Postgres local;
`enviar-whatsapp-plantilla` hace, como máximo, una consulta adicional de configuración
antes de encolar la aprobación. No hay evidencia de que ElevenLabs vaya a reintentar una
llamada de tool que tarde o falle — eso importa para la idempotencia de
`crear_tarea_housekeeping`/`crear_ticket_mantenimiento`/`crear_ticket_huesped` (hoy
NINGUNA de las tres es idempotente ante un reintento exacto: un reintento crearía una
segunda fila duplicada). Pendiente de diseño si en la práctica ElevenLabs reintenta.

## 3. Qué hacer en la primera llamada de prueba real

1. Activa el hotel piloto (`PATCH /voz/config` con `habilitado: true`) y, si quieres ver
   efectos reales en vez de "modo shadow", fija el gate de `recepcion_virtual` a
   `"propone"` para ESE hotel (`PATCH /hoteles/:hotelId/agentes/recepcion_virtual/config`).
2. Haz una llamada real de prueba (ver runbook) que dispare una sola tool.
3. Revisa los logs del servidor (`deps.logger`, nivel info/debug) o añade un log
   temporal en `vozElevenlabsRoutes` que imprima `JSON.stringify(raw)` ANTES de
   `extractToolParams()`, para confirmar la forma real del cuerpo.
4. Actualiza la §2.1/§2.2 de este documento con el resultado confirmado, y si la forma
   real resultó ser SIEMPRE una de las dos, considera simplificar `extractToolParams()`
   (hoy soporta ambas a propósito, por si acaso).
