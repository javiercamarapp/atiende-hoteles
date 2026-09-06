# @atiende-hoteles/email

Sistema de correo transaccional de Atiende Hoteles (H12a, REQ-LAUNCH-010/011/012): puerto
`EmailPort` (puerto/adaptador, ADR-007), 3 adaptadores de envío, 12 plantillas HTML+texto
plano con la marca visual de atiende-restaurantes, y un script de preview con capturas.
Mismo patrón que el resto del monorepo: se importa el `.ts` fuente directamente vía
workspaces (`exports: { ".": "./src/index.ts" }`), sin paso de build.

## Por qué existe

Ningún correo transaccional (verificación de cuenta, invitación de staff, confirmación de
reserva, recibo de pago, aviso de CFDI...) debe depender de un proveedor real para poder
desarrollarse y probarse: `FakeEmailAdapter` persiste cada mensaje en la tabla
`email_outbox` (migración `packages/db/migrations/0094_email_outbox.sql`) o en un
directorio local de archivos `.json`, sin llamar nunca a una red externa. Los adaptadores
reales (`ResendAdapter`/`SmtpAdapter`) son "esqueletos honestos": el código que habla con
el proveedor está completo, pero sin credenciales `configured` es `false` y `send()`
devuelve `status: "no_configurado"` explícito — nunca se finge un envío exitoso.

## Estructura

- **`src/port.ts`** — contrato `EmailPort`/`EmailMessage`/`RenderedEmail`/`EmailSendResult`.
- **`src/layout.ts`** — sistema visual compartido por TODAS las plantillas: tabla de ancho
  fluido con tope en 600px, fondo `#f7f9fc`, tarjeta blanca borde `#e2e8f0` radio 16px,
  wordmark "atiende" en texto azul `#1D4ED8` (nunca imagen — Gmail las bloquea por
  default), tipografía Inter/Inter Tight con fallback de sistema. Reproduce 1:1 el estilo
  de `atiende-restaurantes` (`docs/correo-auth/magic-link.html`,
  `docs/correo-auth/cambio-de-correo.html`, `docs/correo-ventas/prospeccion.html`).
  Exporta `escapeHtml()` — OBLIGATORIO para cualquier dato externo (nombre de huésped,
  nombre de hotel escrito por el usuario, notas) antes de interpolarlo en HTML.
- **`src/format.ts`** — `formatCurrencyMXN`/`formatDateEsMx`, un solo lugar para el formato.
- **`src/adapters/`**:
  - `fakeEmailAdapter.ts` — dev/test/preview. `dbEmailOutboxSink(db)` (tabla
    `email_outbox`) o `fileEmailOutboxSink(dir)` (archivos `.json`, usado por
    `scripts/preview.ts`). Deduplica por `EmailMessage.dedupeKey`.
  - `resendAdapter.ts` — [Resend](https://resend.com) real vía `fetch` nativo (sin SDK).
  - `smtpAdapter.ts` — cliente SMTP mínimo escrito a mano sobre `node:tls`/`node:net`
    (TLS implícito puerto 465 o STARTTLS puerto 587) — sin dependencia nueva como
    `nodemailer`.
- **`src/templates/*.ts`** — 12 plantillas (`render<Nombre>()`/`sample<Nombre>Data()`), ver
  tabla abajo. `src/templates/index.ts` expone el registro `TEMPLATES` (slug → render/sample).
- **`scripts/preview.ts`** — `npm run email:preview`: renderiza las 12 plantillas a
  `docs/correos/preview/<slug>.html` y las captura con Chromium headless
  (`playwright-core`) a 600px (`<slug>.png`) y 375px móvil (`<slug>-movil.png`).

## Las 12 plantillas

| Slug (`EmailMessage.template`) | Uso | Disparador |
|---|---|---|
| `verificacion-cuenta` | Confirmar correo del alta autoservicio | `POST /registro` (routes/registro.ts) |
| `magic-link` | Acceso sin contraseña | Lista para uso futuro — ningún endpoint de este hito emite magic link (ADR-004 usa JWT propio + Google, no magic link) |
| `bienvenida-hotel` | Bienvenida tras verificar/registrar con Google | `POST /registro/verificar`, alta por Google (routes/auth-google.ts) |
| `invitacion-staff` | Invitar a un colega con rol | `POST /hoteles/:hotelId/staff/invitaciones` (routes/correo.ts) |
| `restablecer-contrasena` | "Olvidé mi contraseña" | `POST /auth/olvide-password` (routes/correo.ts) |
| `cambio-correo` | Confirmar nuevo correo de una cuenta | `POST /auth/me/cambiar-correo` (routes/correo.ts) |
| `confirmacion-reserva` | Confirmación de reserva al huésped | Disparador por outbox — ver "Estado de los disparadores" abajo |
| `recordatorio-prellegada` | Recordatorio 1 día antes del check-in | Plantilla lista; sin planificador de recordatorios en este hito |
| `agradecimiento-poststay` | Agradecimiento + enlace de reseña | Plantilla lista; sin planificador post-estancia en este hito |
| `recibo-pago` | Recibo de un pago registrado | Disparador por outbox — REAL, ver abajo |
| `cfdi-disponible` | Aviso de CFDI timbrado | Disparador por outbox — ver "Estado de los disparadores" abajo |
| `prospeccion-comercial` | Correo B2B frío | Sin disparador automático (uso manual/campaña) |

## Estado de los disparadores por outbox (honesto, no todos están "conectados")

`apps/api/src/emailOutbox/buildEmailOutboxHandlers.ts` construye los `OutboxHandler` que
traducen un evento de `public.outbox` a un correo real:

- **`payment.recorded` → `recibo-pago`: REALMENTE conectado.** Ese evento ya lo emite
  `routes/folios.ts` en cada pago registrado (código de otro lote, sin tocar) — basta con
  que algo drene `outbox` (ver `runEmailOutboxWorker.ts`) para que un pago real dispare un
  correo real. Probado end-to-end contra el endpoint real de pagos en
  `tests/integration/api/email-outbox-handlers.spec.ts`.
- **`reservation.confirmed` → `confirmacion-reserva`** y **`cfdi.emitted` →
  `cfdi-disponible`: handler completo y probado, PENDIENTE de que `routes/reservas.ts`/
  `routes/cfdi.ts` (fuera del alcance de este agente) inserten el evento correspondiente en
  `outbox` — documentado con el archivo/línea exactos en la cabecera de
  `buildEmailOutboxHandlers.ts`.
- El worker en sí (`runEmailOutboxWorker.ts`) es un planificador standalone (mismo patrón
  que `scripts/run-night-audit-scheduler.ts`) — arrancarlo junto al resto de
  `apps/api/src/server.ts` requiere una línea en ese archivo, fuera del alcance de este
  agente (lote A). Mientras tanto se corre como proceso independiente o se ejercita
  directo con `drainOutboxOnce()` en pruebas.

## Variables de entorno (rellenar en el `.env` de `apps/api`, ver `apps/api/.env.example`)

Ninguna es obligatoria: sin ellas, `createApp()` usa `FakeEmailAdapter` automáticamente
(nunca falla el arranque por falta de credenciales de correo).

### Opción A — Resend (recomendado)

| Variable | Cómo obtenerla |
|---|---|
| `RESEND_API_KEY` | [resend.com](https://resend.com) → "API Keys" → crear una con permiso de envío. |
| `RESEND_FROM_EMAIL` | Debe ser una dirección de un dominio **verificado** en resend.com/domains (agrega los registros DNS SPF/DKIM que Resend te da y espera a que el dominio quede "Verified", hasta 48h). Resend rechaza remitentes de un dominio no verificado. |

### Opción B — SMTP genérico (Amazon SES, SendGrid, Mailgun, servidor propio)

| Variable | Descripción |
|---|---|
| `SMTP_HOST` | Host del servidor SMTP. |
| `SMTP_PORT` | `465` (TLS implícito) o `587` (STARTTLS, default). |
| `SMTP_USER` / `SMTP_PASS` | Credenciales de autenticación (`AUTH LOGIN`). |
| `SMTP_FROM` | Dirección remitente. |

Si ambas opciones están configuradas, `ResendAdapter` tiene prioridad (ver
`resolveEmailPort()` en `runEmailOutboxWorker.ts`). **Pendiente-coordinación**: estas
variables ya las leen los adaptadores en cuanto algo los instancia, pero
`apps/api/src/server.ts` (fuera de alcance) todavía no construye un `EmailPort` real para
las rutas de registro/correo — ver la nota en `apps/api/.env.example`.

## Ver las plantillas

```bash
npm run email:preview -w @atiende-hoteles/email
# o: node --experimental-strip-types packages/email/scripts/preview.ts
```

Genera `docs/correos/preview/<slug>.html` + `<slug>.png` (600px) + `<slug>-movil.png`
(375px) para las 12 plantillas. Revisa las capturas después de cualquier cambio a
`layout.ts` o a una plantilla — un ejemplo real de lo que se corrigió así: la tabla
principal usaba `width="600"` (atributo HTML fijo) + `style="max-width:100%"`, que
Chromium ignoraba en el layout "auto" de tablas, produciendo overflow horizontal a
375px; el arreglo fue invertir el patrón a `width="100%" style="max-width:600px"`.

## Pruebas

- `tests/unit/email/plantillas.spec.ts` — cada plantilla, con datos de muestra: sin
  `undefined`/`[object`, contiene datos clave en HTML y texto plano.
- `tests/unit/email/sanitizacion.spec.ts` — payload de inyección HTML en campos de
  huésped/staff queda neutralizado (`escapeHtml`).
- `tests/unit/email/adaptadores.spec.ts` — `ResendAdapter`/`SmtpAdapter` sin configurar →
  `no_configurado`; `FakeEmailAdapter` con `fileEmailOutboxSink` → dedupe por
  `dedupeKey`.
- `tests/integration/api/email-outbox-handlers.spec.ts` — disparador `payment.recorded`
  end-to-end contra el endpoint real de pagos.
