# Inventario punta a punta — Likida, Atiende Restaurantes y Atiende Hoteles

Estudio de **solo lectura** de los tres repos para construir la matriz de huecos
que separa a Atiende Hoteles de estar "listo para salir a promoción" al nivel
de sus dos productos hermanos. No se modificó nada en ningún repo de
referencia; no se leyó ningún `.env`/`.env.local`/`.vercel` real (solo nombres
de variables de `.env.example`); no se cita contenido de secretos.

Repos:
- **Likida**: `/Users/javiercamaraportepetit/Documents/Codex/2026-08-23/realtime-voice-chat/audit-likida` (Next.js 16, back-office fiscal de flotas de carga por WhatsApp — pese al nombre de la carpeta padre, no tiene voz).
- **Atiende Restaurantes**: `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes` (Vite+React SPA, pedidos por voz/WhatsApp para restaurantes).
- **Atiende Hoteles**: `/Users/javiercamaraportepetit/Documents/Codex/atiende-hoteles-staging` (monorepo Turborepo, Hono+React, el producto a llevar a producción).

**Contexto que condiciona todo el documento**: `docs/TRAZABILIDAD.md` (raíz de
Hoteles) declara que de 276 requisitos canónicos solo 18 están "hecho" (6.5%),
y `docs/BLOQUEOS.md` (`D-005`) registra que el alcance exacto de esta tarea
—OAuth Google, correos transaccionales, alta autoservicio, despliegue— **fue
pedido pero aún no construido**. Hoteles tiene una base de dominio hotelero e
IA muy sólida (RLS real, idempotencia, agentes con presupuesto/aprobación,
auditoría adversarial documentada) pero carece casi por completo de la capa
"de negocio SaaS" (alta, cobro, correo, despliegue) que Likida y Restaurantes
sí tienen resuelta en mayor o menor grado.

---

## 1. Matriz de capacidades

Leyenda estado Hoteles: ✅ existe · 🟡 parcial · ❌ falta.

| # | Capacidad | Likida (cómo, archivo) | Restaurantes (cómo, archivo) | Hoteles hoy | Qué falta exactamente |
|---|---|---|---|---|---|
| 1 | Auth: email+contraseña | ❌ no existe (100% passwordless) | ❌ no existe (100% passwordless) | ✅ `apps/api/src/routes/auth.ts` (scrypt, JWT propio `jose` HS256 vía `apps/api/src/lib/jwt.ts`) | Nada — Hoteles es el único de los tres con password real, ya funcional. |
| 2 | Auth: magic link / OTP | ✅ `src/app/login/page.tsx`, `src/app/login/respuesta_otp.ts`, `src/app/auth/callback/route.ts` | ✅ `src/pages/AdminLogin.tsx` (`signInWithOtp`, flujo implícito, gate a un email admin) | ❌ no existe | Construir emisión+verificación de OTP/enlace propio (Hoteles no usa Supabase Auth, así que no es "activar un checkbox" — hay que emitir token, mandarlo por correo (dep. de #4) y validarlo contra `apps/api`). |
| 3 | Auth: Google OAuth | ❌ no existe | ✅ `src/pages/AdminLogin.tsx` (`signInWithOAuth({provider:"google"})`) | ❌ no existe (`docs/PROGRESO.md` lo marca como desvío intencional; `BLOQUEOS.md` D-005) | Implementar flujo OAuth 2.0 con Google (callback, vinculación a `staff_user` existente) — Hoteles no tiene Supabase Auth de por medio, así que es más trabajo que en Restaurantes. |
| 4 | Auth: sesión/cookies | Cookies httpOnly de Supabase Auth (`src/lib/auth/session.ts`, `guard.ts`) | Cookies de Supabase Auth (implícito, `previewAuthStorage.ts` para preview) | 🟡 token JWT en `localStorage` (`apps/web/src/hooks/useAuth.tsx`), sin cookie httpOnly | Migrar (o complementar) a cookie httpOnly/SameSite para reducir superficie XSS, o documentar por qué se acepta el riesgo. |
| 5 | Auth: MFA | ✅ TOTP nativo con step-up AAL1→AAL2 (`src/lib/auth/mfa.ts`) | ❌ no existe | ❌ no existe | Construir TOTP propio (Hoteles no tiene Supabase Auth) — al menos para rol `owner`/`accountant` que mueven dinero (coincide con hallazgo GOB-026 de `docs/auditoria-2/agentico.md`). |
| 6 | Auth: recuperación de contraseña | N/A (passwordless) | N/A (passwordless) | ❌ no existe (`auth.ts` no tiene `/forgot`/`/reset`) | Es el único de los tres que la necesita (es el único con password real). Construir flujo forgot/reset con token de un solo uso + correo (dep. de #4). |
| 7 | Auth: cambio de correo | Vía plantilla `email_change` (`src/lib/correo/auth.ts`) | Vía plantilla Supabase `docs/correo-auth/cambio-de-correo.html`, sin UI en panel | ❌ no existe (solo `PATCH /auth/me/whatsapp`) | Endpoint + UI para cambiar correo con doble confirmación. |
| 8 | Registro/alta autoservicio (crear negocio) | ❌ no hay autoregistro público (`src/app/login/no_autoregistro.test.ts` lo prueba explícitamente); alta la hace superadmin (`src/app/admin/usuarios/nuevo`) | ❌ no hay autoservicio; alta solo por SQL/migración/seed | ❌ no existe (`apps/api/src/routes/hoteles.ts` solo tiene `GET`) | Los tres carecen de self-signup público real. Para Hoteles, el hueco más barato es igualar el patrón de "invitar" (ver #9), no construir signup público desde cero. |
| 9 | Invitar equipo | ✅ `src/lib/auth/invitar.ts`, `provisionar.ts` (dueño de flota invita desde su panel) | ✅ `ModalCuenta.tsx` → Edge Function `crear-cuenta-staff/index.ts` (`admin.createUser`, sin password) | ❌ no existe | Construir `POST /hoteles/:id/staff/invitar` + UI, usando el patrón de "crear usuario sin contraseña, primer acceso por link" de ambos hermanos. |
| 10 | Onboarding guiado (wizard) | ✅ `src/app/dashboard/onboarding/{page,chat,forma}.tsx` + `api/dashboard/onboarding-chat` (chat conversacional) | ❌ no existe | ❌ no existe | Construir wizard de primera configuración (tarifas, roles, canales) — Hoteles ya tiene `packages/agent-core` con Anthropic, puede replicar el patrón de chat de Likida sin dependencia nueva. |
| 11 | Roles y permisos | `superadmin, flota_admin, contador, operador, encargado` (`src/lib/auth/permisos.ts`) | `app_role` (admin/user/repartidor/superadmin) + `restaurant_staff.role` por tenant | ✅ 8 roles (`owner,gm,frontdesk,reservations,housekeeping,maintenance,fnb,accountant`) con RLS helpers (`packages/db/migrations/0003_membership_and_rls_helpers.sql`) | Nada — el sistema de roles de Hoteles es más granular que el de ambos hermanos. |
| 12 | Superadmin cross-tenant (consola) | ✅ `src/app/admin/*` (46 páginas): métricas, costo de IA por tenant (`getResumenNegocio`, RPC `resumen_negocio()`), gestión de flotas/agentes, QA/evals | ✅ `src/pages/SuperAdminDashboard.tsx` (780 líneas): métricas de plataforma vía RPCs agregadas, sin MRR/costo IA (explícito) | ❌ no existe — solo mencionado como concepto pendiente en `docs/ARQUITECTURA.md` ADR-004 | Construir consola `/admin` cross-org: lista de hoteles, costo de IA agregado (Hoteles ya trackea costo por agente en `packages/agent-core/budget.ts`, falta agregarlo cross-tenant), gestión de agentes. |
| 13 | Correo transaccional: proveedor | ✅ Resend (`RESEND_API_KEY`), hook propio de Supabase Auth (`src/app/api/auth/correo/route.ts`) | ✅ Resend (`RESEND_API_KEY`, `RESEND_FROM`), `supabase/functions/send-order-notification/index.ts` | ❌ ningún proveedor conectado (`ADR-007` lo declara `MessagingPort` [PENDIENTE DE CREDENCIALES]) | Integrar Resend (mismo proveedor que ambos hermanos, reduce fricción de reutilizar plantillas), definir `EMAIL_FROM`/dominio verificado. |
| 14 | Correo: plantillas HTML de marca | ✅ `src/lib/correo/plantilla.ts` (shell) + 12 plantillas en `docs/correo-auth/*.html` | ✅ `_shared/emails/plantilla.ts` (shell) + 7 en `_shared/emails/plantillas.ts` + 2 en `docs/correo-auth/*.html` | ❌ no existen | Portar el patrón de "shell + plantillas por evento" (ver §4 de este documento) adaptando paleta/textos a Hoteles. |
| 15 | Correo: eventos disparados | Auth (magic link, invite, recovery, email_change) + producto (`avisoVigencias`, `avisoCorridaFallida`, `avisoInvitacion`, etc. en `src/lib/correo/avisos.ts`) | Pedido nuevo/preparando/en camino/entregado/cancelado/problema + bienvenida (`_shared/emails/plantillas.ts`) | ❌ ningún evento dispara correo hoy | Cablear: confirmación de reserva, check-in/check-out, recibo/folio, invitación de staff, reset de contraseña, alerta de aprobación pendiente. |
| 16 | Correo de ventas/prospección | Leads: `src/app/api/lead/route.ts`; onboarding de prospectos vía `/aviso/prospectos` | ✅ `docs/correo-ventas/prospeccion.html` | ❌ no existe | Adaptar `docs/correo-ventas/prospeccion.html` de Restaurantes a hoteles (placeholders `{{HOTEL}}`, `{{CONTACTO}}`). |
| 17 | Notificaciones in-app | ✅ `src/app/dashboard/notificaciones/page.tsx` (KPIs, anomalías, escalados, huérfanos) | ✅ `NotificacionesSection.tsx` (1022 líneas, estilo Rappi, tabs, preferencias por evento, leído/no-leído) | ❌ no existe | Construir centro de notificaciones in-app usando el patrón de tabs+preferencias de Restaurantes; Hoteles ya tiene eventos internos (aprobaciones, agentes) que alimentarían este centro. |
| 18 | Notificaciones push (web push) | ❌ no existe | ❌ no existe | ❌ no existe | Ningún hermano lo resolvió — no es gap relativo, es oportunidad nueva si se quiere diferenciar (baja prioridad para el lanzamiento). |
| 19 | WhatsApp: webhook + validación | ✅ `src/app/api/webhook/whatsapp/route.ts` (dedupe, ratelimit) | ✅ `supabase/functions/whatsapp-webhook/index.ts` + `meta-signature.ts` (HMAC) | ✅ `apps/api/src/routes/mensajeria.ts` (HMAC contra `webhook_secret` del hotel, idempotente por `event_id`) | Nada estructural — falta solo credenciales reales de Meta (adaptador hoy es `fake-whatsapp-adapter.ts`). |
| 20 | WhatsApp: plantillas de mensaje | `scripts/mandar-plantillas-meta-fase0.sh`, `docs/conocimiento/CONFIGURAR-META.md` | Sin plantillas Meta Business (reactivo) | 🟡 `hotel_messaging_config.transactional_templates` (auto-aprobadas), resto vía `agent_approval` | Documentar/registrar plantillas ante Meta Business Manager (paso operativo, no de código) siguiendo la guía de Likida. |
| 21 | WhatsApp: opt-in/consentimiento | 🟡 aviso LFPDPPP público por tenant (`/aviso/[tenant]`), no doble opt-in Meta | ❌ no existe (reactivo, sin templates outbound) | ❌ no existe — hallazgo [ALTO] confirmado en `docs/auditoria-2/legal.md` (sin tabla de consentimiento, webhook no reconoce "BAJA") | Construir tabla de consentimiento + reconocer palabra de baja en el webhook; adaptar el patrón de aviso público de Likida (`/aviso/[tenant]`). |
| 22 | Voz (agente conversacional) | ❌ no existe (pese al nombre de la carpeta padre) | ✅ ElevenLabs Conversational AI + clonación de voz (`supabase/functions/agent-config/index.ts`, `src/components/ModalClonarVoz.tsx`) | ❌ no existe — solo `VoicePort` conceptual en ADR-007 [PENDIENTE DE CREDENCIALES] | Integrar ElevenLabs siguiendo el patrón exacto de Restaurantes (proxy autenticado, API key en vault, tools server-side). Ningún LiveKit en ningún repo de referencia. |
| 23 | Agentes de IA: configuración en UI | ✅ `src/app/admin/agentes/page.tsx` (alta), paneles por agente en `dashboard/agentes/*` (controles, estrategia) | ✅ `WhatsAppAgenteConfigSection.tsx` + editor en `AdminDashboard.tsx` (prompt, modelo, temperatura, tono) | ✅ `apps/web/src/pages/Agentes.tsx` (gate shadow/propone/autopilot, techo USD, demo simulada) | Nada estructural — Hoteles ya iguala o supera en gobierno (gates + techo + aprobación), falta solo credenciales reales (`ANTHROPIC_API_KEY`) y consola cross-tenant (#12). |
| 24 | Facturación/cobro del SaaS al cliente | ✅ Stripe (`src/lib/saas/stripe.ts`) + transferencia directa + CFDI propio (FacturAPI) + `dashboard/suscripcion/page.tsx` | ❌ no existe (botón placeholder en `SuperAdminDashboard.tsx`) | ❌ no existe (`mcp-servers/payments` es para que el hotel cobre al huésped, no al revés) | Construir plan+suscripción+cobro del hotel hacia Atiende, siguiendo el patrón completo de Likida (Stripe + transferencia + CFDI). Es el hueco de negocio más grande de los tres. |
| 25 | Legales: privacidad/términos | ✅ `src/app/privacidad`, `terminos`, `/aviso/[tenant]` dinámico por tenant | ✅ `Privacidad.tsx`, `Terminos.tsx`, `LegalPage.tsx` (marca datos faltantes explícitamente) | 🟡 `Privacidad.tsx`, `Terminos.tsx`, `LegalPage.tsx` existen + backend ARCO real (`routes/privacidad.ts`) | Aviso de privacidad no declara transferencia de datos a Anthropic (hallazgo `docs/auditoria-2/legal.md`); sin consentimiento en check-in online; PAN de tarjeta en texto plano en WhatsApp sin redacción. |
| 26 | Legales: cookies/DPO | ❌ ninguno de los tres tiene banner de cookies ni figura de DPO explícita | ❌ igual | ❌ igual | Gap compartido por los tres — construirlo antes de la landing pública (que sí usará analítica/cookies). |
| 27 | Legales enterprise (DPA/SLA) | ✅ `docs/legal/{00-CHECKLIST-ENTERPRISE,01-DPA-PLANTILLA,02-SLA-PLANTILLA,03-ANEXO-SEGURIDAD-PLANTILLA,04-SUBENCARGADOS-PLANTILLA}.md` | ❌ no existe | ❌ no existe | Portar las 5 plantillas de Likida (son genéricas de SaaS B2B, requieren poco ajuste). |
| 28 | SEO/meta/OG/robots/sitemap (app) | ❌ ninguno (`noindex` implícito, marketing vive en `likida.ai` aparte) | `noindex,nofollow` explícito en `index.html`, `robots.txt: Disallow /` | 🟡 `noindex,nofollow` explícito en `apps/web/index.html`, sin `robots.txt`/sitemap | Añadir `robots.txt` explícito (aunque sea para confirmar el `noindex`) — detalle menor, ya alineado con el patrón correcto de "panel no se indexa". |
| 29 | Landing/marketing | Vive aparte en `likida.ai` (HTML estático, otro proyecto) | Vive aparte, pendiente (`useatiende.ai/restaurantes`) | ❌ no existe en ningún lado (ni en este repo ni referencia a un proyecto separado) | Construir landing de venta — es el único de los tres sin ningún avance, ni siquiera "pendiente en otro repo" documentado. |
| 30 | PWA/offline | ❌ no existe | ❌ no existe | ✅ `apps/web/public/manifest.json` + `sw.js` (cachea shell, sin offline-first de datos) | Nada urgente — Hoteles ya va adelante de ambos hermanos aquí. |
| 31 | i18n | ❌ ninguno de los tres | ❌ igual | ❌ igual | Gap compartido, no bloqueante para México (mercado único es-MX en los tres). |
| 32 | Accesibilidad y temas | Tema neutro sin modo oscuro (decisión de `DESIGN.md`); sin auditoría axe automatizada encontrada | `ThemeSelector.tsx` claro/oscuro/sistema; sin axe automatizado | ✅ `ThemeSelector.tsx` (paquete `ui`) + `tests/e2e/axe-accesibilidad.spec.ts` (axe-core real) | Nada — Hoteles es el único con test de accesibilidad automatizado corriendo. |
| 33 | Analítica de producto (PostHog/GA) | ❌ no existe | ❌ no existe | ❌ no existe | Gap compartido — construir cuando exista landing (#29), no bloqueante para el producto en sí. |
| 34 | Observabilidad (Sentry) | ✅ `src/lib/observability/sentry.ts` (solo server, sin DSN de cliente) | ❌ no existe (logging propio con correlation ID) | ❌ no existe (logging propio `pino` + `/metrics`, `/health`) | Integrar Sentry server-side siguiendo el patrón de Likida (server-only, sin exponer DSN al cliente). |
| 35 | Despliegue: hosting/dominio | ✅ Vercel, `app.likida.ai`, deploy opt-in vía `ignoreCommand`/`[deploy]` en commit | ✅ Vercel, `app.useatiende.ai/restaurantes`, redirects legacy | ❌ sin `vercel.json`, sin dominio configurado en ningún archivo | Elegir dominio, crear proyecto Vercel, escribir `vercel.json` (headers, rewrites SPA+API). |
| 36 | Despliegue: base de datos remota | Supabase remoto (186 migraciones aplicadas, gestionado por dashboard) | Supabase remoto (47 migraciones, `project_id` en `config.toml`) | ❌ `embedded-postgres` local incluso en CI/producción — decisión de Supabase real pendiente (`docs/BLOQUEOS.md` D-001) | Decidir (fundador) y ejecutar migración a Supabase real; las 69 migraciones ya están listas y son "expand-only" (`packages/db/migrations`), portables. |
| 37 | Despliegue: CI/CD completo | ✅ `.github/workflows/{ci,ci-postgres,codeql,backup-storage,salud-produccion,deploy-preview-promote,rollback-production,dependabot}.yml` | ✅ `.github/workflows/{quality,messaging-dispatcher}.yml` | 🟡 `.github/workflows/ci.yml` (lint→typecheck→test→build→e2e→npm audit encadenados), sin deploy | Añadir job de deploy, salud post-deploy (cron `salud-produccion.yml` de Likida), y opcionalmente CodeQL. |
| 38 | Backups/restore | `scripts/{respaldo,restore-storage-drill,respaldo-storage}.sh` + workflow `backup-storage.yml` | Pruebas de aislamiento en `supabase/tests/*.sh`, sin workflow de backup dedicado encontrado | 🟡 `scripts/backup.sh/.ts`, `restore.sh/.ts` existen, pero **hallazgo confirmado**: `restore.sh` reporta "conteo igual" sobre un backup vacío de 0 tablas (`docs/auditoria-2/operabilidad.md`) | Corregir la verificación de `restore.sh` (falso positivo) antes de confiar en el backup para producción real. |
| 39 | Seguridad: headers/CSP | ✅ CSP enforced en `src/proxy.ts` (HTML) + cabeceras `/api/*` en `next.config.ts` (CSP `default-src 'none'`, HSTS prod) | ❌ sin CSP/HSTS explícitos | 🟡 `hono/secure-headers` (HSTS prod, X-Frame-Options DENY, frame-ancestors none) sin CSP completa | Completar CSP (`default-src`, `script-src`, etc.) siguiendo el patrón de `next.config.ts` de Likida. |
| 40 | Seguridad: rate limiting | ✅ Upstash Redis, fail-closed configurable (`src/lib/ratelimit.ts`) | ✅ Postgres RPC `consume_api_rate_limit` (`_shared/http-security.ts`) | 🟡 en memoria (`apps/api/src/lib/rateLimit.ts`), interfaz sustituible por Redis pero no conectada | Conectar a Redis/Upstash o Postgres (cualquiera de los dos patrones de los hermanos) antes de multi-instancia en producción. |
| 41 | Seguridad: aislamiento cross-tenant (bug real) | N/A (RLS extensivo, sin hallazgo equivalente reportado en este pase) | RPCs de superadmin con `security definer` + check explícito `is_superadmin`/`can_manage_restaurant` en cada función (`20260904061000_superadmin_platform_rpc.sql`) | ❌ **CRÍTICO**: `checkinOnline.ts` cruza documento de identidad entre hoteles; `mark_charge_reversed()`, `night_audit_claim/finish()`, `sat_filing_approval` (todas `SECURITY DEFINER`) no validan `hotel_id`/`tenant_id` del actor (`docs/auditoria-2/seguridad.md`, nota 2/10) | Añadir el check de tenant explícito que sí tienen las funciones `security definer` de Restaurantes en cada RPC listada — es bloqueante de lanzamiento, no solo de paridad. |
| 42 | Documentación operativa (runbooks) | ✅ `docs/conocimiento/DEPLOY.md`, `docs/operacion/RESILIENCIA-DEPLOY.md` | ✅ `docs/runbooks/operacion.md`, `docs/deployment-domains.md` | ✅ `docs/runbooks/{backups-restauracion,despliegue,incidentes,migraciones,operacion}.md` | Nada de fondo — falta solo que `despliegue.md` deje de decir "sin despliegue automático todavía" (depende de #35-37). |
| 43 | Documentación de ventas/demo | ✅ `docs/conocimiento/guion-demo.md`, `docs/demo-5k*.md`, `docs/demo-facturacion-lunes.md` | ✅ `docs/audits/demo-readiness-2026-09-04.md`, seed de 90k pedidos | ❌ no existe ningún guion de demo ni checklist de demo-readiness | Escribir guion de demo + checklist "demo-readiness" (formato de Restaurantes es el más corto de portar). |
| 44 | Demo/tour interactivo del producto | ✅ `src/app/demo/page.tsx` (simulador de WhatsApp sin número real) | Widget de demo (`WidgetWhatsApp.tsx`, mismo cerebro que WhatsApp real) + seed de volumen | 🟡 solo botón "Demo (simulada)" por agente individual en `Agentes.tsx` (`FakeProvider`) | Construir un simulador de conversación end-to-end (reserva/check-in) reutilizando `FakeProvider` ya existente, no solo por agente aislado. |
| 45 | Soporte (centro de ayuda / tickets) | ✅ sistema de tickets con SLA (`dashboard/soporte/page.tsx`, tabla `ticket_soporte`) | 🟡 placeholders sin página real, excepto "soporte vía WhatsApp al administrador" en `RepartidorDashboard.tsx` | ❌ no existe | Construir cola de tickets con SLA siguiendo el patrón de Likida, o al menos el fallback barato de Restaurantes (WhatsApp al soporte). |

---

## 2. Cómo está armado cada producto

### 2.1 Likida

Aplicación Next.js 16 (App Router, React 19, TypeScript estricto) monolítica
desplegada en Vercel bajo `app.likida.ai`, con Postgres gestionado por
Supabase (RLS multi-tenant por `tenant_id`, RPCs SQL para agregaciones,
~186 migraciones en `supabase/migrations/`). Autenticación sin contraseña:
Supabase Auth emite magic link/OTP, pero el envío del correo se intercepta
vía un "Send Email Hook" propio (`POST /api/auth/correo`) que redacta el
HTML con marca Likida (`src/lib/correo/auth.ts` + `plantilla.ts`) y lo
despacha por Resend en vez de la plantilla en inglés de fábrica; hay MFA TOTP
opcional con step-up a AAL2 para acciones sensibles. No existe autoregistro
público: el alta de tenants/usuarios la hace el superadmin o el dueño de
flota invita desde su panel. El flujo operativo central: el operador de un
camión manda por WhatsApp (Meta Cloud API) la foto de un comprobante; el
webhook la recibe, la pasa por OCR/visión (OpenRouter) y valida el CFDI
contra el SAT; un motor de "cuadre" 100% determinista en TypeScript (no LLM)
concilia el gasto contra la política de la empresa citando el fundamento
legal exacto (corpus normativo YAML en `normas/`); al cerrar el viaje se
genera un PDF de liquidación y se exporta al ERP de la flota. Hay un segundo
panel `/admin` (superadmin, cruza todos los tenants a propósito) con gestión
de agentes de IA, QA/evals, costo de IA por tenant, y un mini-CRM de ventas.
La facturación del SaaS combina Stripe, transferencia bancaria directa, y
CFDI propio vía FacturAPI. Crons de Vercel manejan colas de WhatsApp,
corridas de agentes, escalaciones, facturación automatizada (Playwright
headless contra portales de autofactura) y purgas de retención. Deploy es
opt-in (requiere `[deploy]` en el commit); hay CI (typecheck/lint/tests),
CodeQL, backups programados, y flujo preview→smoke→promote con rollback
manual. CSP enforced vía `proxy.ts` para HTML y cabeceras separadas para
`/api/*`; rate limiting con Upstash Redis fail-closed. No hay landing (vive
en `likida.ai`, otro proyecto), no hay voz/realtime pese al nombre de la
carpeta padre, no hay PWA, no hay i18n, no hay analítica de producto ni
Sentry en cliente (solo server).

### 2.2 Atiende Restaurantes

SPA Vite + React 18 + TypeScript + shadcn/ui + Tailwind, servida como panel
de operación interno (no landing pública — `noindex,nofollow` a propósito),
con `react-router-dom` y basename `/restaurantes` en producción (Vercel). El
backend es Supabase (Postgres con RLS exhaustivo, Auth, Edge Functions en
Deno). La autenticación es sin contraseña: solo magic link (`signInWithOtp`,
flujo implícito) y Google OAuth, consumidos manualmente del hash de la URL
por una condición de carrera documentada en comentarios; no hay registro
público ni recuperación de contraseña porque no existen contraseñas. Los
roles viven en `user_roles` (enum `app_role`) y `restaurant_staff` (owner/
admin/repartidor por tenant), con RLS y funciones `security definer`
(`is_superadmin`, `can_manage_restaurant`) gobernando el acceso; existe una
consola superadmin cross-tenant con RPCs agregadas (nunca expone filas
crudas). No hay alta de tenant autoservicio: un nuevo restaurante se crea
manualmente por SQL/migración/seed, y el equipo se invita (sin contraseña,
vía Edge Function con service role) por un admin/superadmin existente — no
hay wizard de onboarding. El correo transaccional (confirmaciones de pedido)
sale por Resend con plantillas HTML propias; las plantillas de Supabase Auth
(magic link, cambio de correo) están documentadas como HTML de referencia en
`docs/correo-auth/`. Los canales de atención al cliente final son voz
(ElevenLabs Conversational AI, con clonación de voz IVC desde el panel,
tools server-side) y WhatsApp (Meta Cloud API con validación HMAC, cerebro
LLM vía OpenRouter), ambos comparten el mismo motor de creación/cotización de
pedidos server-side. Hay notificaciones in-app (centro tipo Rappi) pero no
push web. Deploy es Vercel, dominio `app.useatiende.ai/restaurantes` con
redirects legacy y CORS allowlist estricta; CI en GitHub Actions corre
lint/typecheck/tests/build+budget y un job de base de datos local, más un
cron de 5 min que despacha un outbox de mensajería. No existen: facturación/
planes SaaS, analítica de producto, error tracking externo (hay logging
estructurado propio), i18n, PWA, ni CSP/HSTS explícitos.

### 2.3 Atiende Hoteles (estado actual)

Monorepo npm workspaces + Turborepo. Frontend: Vite 8 + React 18 + TypeScript
+ Tailwind + shadcn/ui (`apps/web`), react-router v7, TanStack Query v5;
identidad visual portada literalmente de Restaurantes (logo, tokens,
sidebar). Backend: Hono sobre Node 22+ (`apps/api`), sin paso de build (TS
nativo con `--experimental-strip-types`), JWT propio con `jose` (access 15
min + refresh 30 días) — no hay Supabase Auth ni GoTrue, es una
reimplementación propia del modelo de permisos. Base de datos: **no es
Supabase remoto** — es `embedded-postgres` corriendo localmente
(`packages/db/.pgdata`), con 69 migraciones SQL versionadas manualmente y RLS
real (`set_config` de claims JWT por transacción, mismo patrón que usaría
Supabase, para portabilidad futura). Multi-tenant: `org` es el tenant real,
cada `hotel` es una location bajo esa org, con 8 roles vía `hotel_staff`; no
existe rol/consola "superadmin" implementada, solo mencionada como concepto
pendiente. Correo transaccional: no existe ningún proveedor conectado,
documentado como integración pendiente de credenciales. Flujo de alta de un
nuevo hotel/tenant: no existe autoservicio — el único mecanismo es el script
de seed de desarrollo. Despliegue: CI en GitHub Actions corre lint/typecheck/
tests/build/e2e con `embedded-postgres` efímero en el runner, pero no hay CD,
no hay `vercel.json`, no hay dominio ni proyecto de hosting configurado en
ningún archivo — "sin despliegue automático a ningún entorno todavía" según
el propio runbook. Integraciones externas reales (PMS, WhatsApp, Stripe/
Conekta, CFDI/PAC, voz, energía/cerraduras IoT) están construidas como
puerto+adaptador con contrato Zod y prueba de contrato, pero corren siempre
contra un adaptador Fake/Simulado — ninguna tiene credenciales reales. El
agente de IA (Anthropic vía `packages/agent-core`) solo se activa con
`ANTHROPIC_API_KEY`. En síntesis: base arquitectónica sólida y disciplinada
(RLS real, idempotencia, advisory locks, outbox, auditoría adversarial
documentada con notas 2-5/10 en varios rubros), pero lejos de "listo para
promoción": faltan autoservicio de alta, Google OAuth, correos
transaccionales, consola superadmin, facturación SaaS, landing/marketing,
SEO, analítica de producto, Sentry, i18n, y cualquier despliegue real.

---

## 3. Lista priorizada de huecos (LAUNCH-nnn)

Orden: bloqueante de seguridad primero, luego por impacto en "salir a
promoción". Esfuerzo: S = días, M = 1-2 semanas, L = varias semanas/decisión
de producto. Dependencia externa: ninguna / credenciales / decisión.

| ID | Descripción verificable | Referencia (archivo) | Esfuerzo | Dependencia externa |
|---|---|---|---|---|
| LAUNCH-001 | Corregir las 4 funciones `SECURITY DEFINER` que no validan `hotel_id`/`tenant_id` del actor (`checkinOnline.ts`, `mark_charge_reversed()`, `night_audit_claim/finish()`, `sat_filing_approval`) — hoy permiten cruce de datos/dinero entre hoteles | Patrón correcto de referencia: `atiende-restaurantes/supabase/migrations/20260904061000_superadmin_platform_rpc.sql` (check `is_superadmin`/`can_manage_restaurant` explícito en cada RPC); hallazgo en `docs/auditoria-2/seguridad.md` | M | ninguna |
| LAUNCH-002 | Conectar `scripts/purge-identity-vault.ts` a un cron/scheduler real (hoy existe pero no arranca en `apps/api/src/server.ts`) | Hallazgo en `docs/auditoria-2/legal.md`; patrón de cron real: `likida/.../vercel.json` (`purgar` diario 4:15am) | S | ninguna |
| LAUNCH-003 | Corregir `restore.sh` para que no reporte "conteo igual" sobre un backup vacío (falso positivo de verificación) | `docs/auditoria-2/operabilidad.md`; referencia de verificación real: `likida/scripts/restore-storage-drill.sh` | S | ninguna |
| LAUNCH-004 | Integrar proveedor de correo transaccional (Resend) con dominio verificado y plantillas de marca | `atiende-restaurantes/supabase/functions/_shared/emails/{plantilla,plantillas}.ts`; `likida/src/lib/correo/{plantilla,avisos}.ts` | M | credenciales (cuenta Resend + dominio) |
| LAUNCH-005 | Cablear eventos de correo: confirmación de reserva, check-in/check-out, recibo/folio, invitación de staff, reset de contraseña, alerta de aprobación pendiente | Mismo patrón "shell + función por evento" de ambos hermanos (ver LAUNCH-004) | M | credenciales (depende de LAUNCH-004) |
| LAUNCH-006 | Construir "invitar equipo" (alta de staff sin contraseña, primer acceso por link) — hoy solo existe seed de desarrollo | `atiende-restaurantes/src/components/ModalCuenta.tsx` + `supabase/functions/crear-cuenta-staff/index.ts`; `likida/src/lib/auth/{invitar,provisionar}.ts` | M | ninguna |
| LAUNCH-007 | Construir consola superadmin cross-tenant (`/admin`): lista de hoteles, costo de IA agregado, gestión de agentes | `likida/src/app/admin/*` (46 páginas) + `getResumenNegocio`; `atiende-restaurantes/src/pages/SuperAdminDashboard.tsx` | L | ninguna |
| LAUNCH-008 | Añadir recuperación de contraseña (forgot/reset con token de un solo uso) — único de los tres productos que usa password real | Patrón genérico (ninguno de los hermanos lo necesita porque son passwordless); implementar sobre `apps/api/src/routes/auth.ts` | S | credenciales (depende de LAUNCH-004 para enviar el correo) |
| LAUNCH-009 | Decidir y ejecutar migración de `embedded-postgres` a Supabase real (o infraestructura Postgres gestionada equivalente) en producción | `atiende-restaurantes/supabase/config.toml`; `likida` (186 migraciones en Supabase remoto); decisión pendiente en `docs/BLOQUEOS.md` D-001 | L | decisión (fundador) + credenciales (proyecto Supabase) |
| LAUNCH-010 | Configurar proyecto Vercel + dominio propio + `vercel.json` (headers, rewrites SPA/API) | `atiende-restaurantes/vercel.json` + `docs/deployment-domains.md`; `likida/vercel.json` (`ignoreCommand` opt-in, crons) | L | decisión (dominio) + credenciales (cuenta Vercel, DNS) |
| LAUNCH-011 | Añadir job de deploy + salud post-deploy al CI (hoy termina en `npm audit`, sin publicar nada) | `likida/.github/workflows/{deploy-preview-promote,rollback-production,salud-produccion}.yml` | M | ninguna (una vez resuelto LAUNCH-010) |
| LAUNCH-012 | Construir alta de negocio + invitación de equipo con onboarding guiado tipo wizard/chat de primera configuración | `likida/src/app/dashboard/onboarding/{page,chat,forma}.tsx` + `api/dashboard/onboarding-chat` | M | ninguna (Hoteles ya tiene `packages/agent-core` con Anthropic) |
| LAUNCH-013 | Añadir Google OAuth como método de login | `atiende-restaurantes/src/pages/AdminLogin.tsx` (`signInWithOAuth`) | L | credenciales (Google OAuth client) |
| LAUNCH-014 | Añadir magic link/OTP como método de login alternativo a password | `atiende-restaurantes/src/pages/AdminLogin.tsx` (`signInWithOtp`); `likida/src/app/login/page.tsx` | M | credenciales (depende de LAUNCH-004) |
| LAUNCH-015 | Construir facturación/cobro del SaaS al hotel (planes, Stripe, trial) — hoy `mcp-servers/payments` solo cobra al huésped, no al hotel | `likida/src/lib/saas/{suscripcion,stripe,transferencia,facturapi}.ts` + `dashboard/suscripcion/page.tsx` | L | credenciales (cuenta Stripe, FacturAPI) |
| LAUNCH-016 | Integrar ElevenLabs para agente de voz | `atiende-restaurantes/supabase/functions/agent-config/index.ts` + `src/components/ModalClonarVoz.tsx` | L | credenciales (API key ElevenLabs) |
| LAUNCH-017 | Construir centro de notificaciones in-app | `atiende-restaurantes/src/components/admin/NotificacionesSection.tsx`; `likida/src/app/dashboard/notificaciones/page.tsx` | M | ninguna |
| LAUNCH-018 | Construir tabla de consentimiento/opt-out de WhatsApp y reconocer palabra de baja en el webhook | `likida/src/app/aviso/[tenant]/page.tsx` (patrón de aviso LFPDPPP por tenant); hallazgo en `docs/auditoria-2/legal.md` | S | decisión (texto legal) |
| LAUNCH-019 | Actualizar aviso de privacidad para declarar la transferencia de la conversación del huésped al proveedor de IA (Anthropic) | `likida/src/app/terminos/page.tsx` §7 (cláusula de IA determinística); hallazgo en `docs/auditoria-2/legal.md` | S | decisión (legal) |
| LAUNCH-020 | Redactar/eliminar el número de tarjeta capturado en texto plano en WhatsApp | Hallazgo `[CRÍTICO]` en `docs/auditoria-2/legal.md`; patrón de redacción: `likida/src/lib/logger.ts` (redacta PII) | M | ninguna |
| LAUNCH-021 | Completar CSP (hoy solo `frameAncestors` vía `hono/secure-headers`) | `likida/next.config.ts` (`headers()`, CSP `default-src 'none'` + HSTS prod) | S | ninguna |
| LAUNCH-022 | Mover rate limiting de memoria a Redis/Postgres compartido antes de correr múltiples instancias | `likida/src/lib/ratelimit.ts` (Upstash, fail-closed); `atiende-restaurantes/supabase/functions/_shared/http-security.ts` (RPC Postgres) | S | credenciales (si se elige Redis) |
| LAUNCH-023 | Integrar Sentry server-side (sin exponer DSN al cliente) | `likida/src/lib/observability/sentry.ts` | S | credenciales (DSN Sentry) |
| LAUNCH-024 | Portar 5 plantillas legales enterprise (DPA, SLA, anexo de seguridad, subencargados, checklist) | `likida/docs/legal/{00-CHECKLIST-ENTERPRISE,01-DPA-PLANTILLA,02-SLA-PLANTILLA,03-ANEXO-SEGURIDAD-PLANTILLA,04-SUBENCARGADOS-PLANTILLA}.md` | S | ninguna |
| LAUNCH-025 | Construir landing/marketing pública de venta — ninguno de los tres la tiene resuelta, pero Hoteles ni siquiera tiene un plan documentado de dónde vivirá | `likida` y `atiende-restaurantes` la resuelven fuera del repo (`likida.ai`, `useatiende.ai/restaurantes` pendiente) | L | decisión (dominio, contenido) |
| LAUNCH-026 | Construir banner de cookies + designar figura/contacto de DPO | Gap compartido por los tres productos — no hay referencia que portar, construir desde cero antes de activar analítica en la landing | S | decisión (legal) |
| LAUNCH-027 | Escribir guion de demo + checklist de "demo-readiness" | `likida/docs/conocimiento/guion-demo.md`; `atiende-restaurantes/docs/audits/demo-readiness-2026-09-04.md` | S | ninguna |
| LAUNCH-028 | Construir simulador de demo end-to-end (reserva/check-in), no solo el botón "Demo (simulada)" por agente aislado | `likida/src/app/demo/page.tsx` (simulador de conversación completo); `apps/web/src/pages/Agentes.tsx` (ya tiene `FakeProvider` reutilizable) | M | ninguna |
| LAUNCH-029 | Construir centro de soporte con cola de tickets y SLA (o al menos el fallback barato "soporte por WhatsApp") | `likida/src/app/dashboard/soporte/page.tsx` + tabla `ticket_soporte`; fallback barato: `atiende-restaurantes/src/pages/RepartidorDashboard.tsx` (~línea 700) | M | ninguna |

---

## 4. Textos y plantillas reutilizables

Todos los archivos listados son HTML/Markdown de marca o legales — ninguno
contiene secretos. Se listan con nota de adaptación a hoteles.

### 4.1 Correo — motor/shell (código, patrón muy portable)
- `atiende-restaurantes/supabase/functions/_shared/emails/plantilla.ts` — función `renderCorreo()`, shell reutilizable (wordmark, tarjeta, botón píldora, tabla de datos, pie). Adaptar paleta a la marca de Hoteles y el wordmark.
- `atiende-restaurantes/supabase/functions/_shared/emails/plantillas.ts` — 7 funciones de evento (pedido nuevo/preparando/en camino/entregado/cancelado/problema, bienvenida). Adaptar a eventos hoteleros: reserva confirmada, check-in listo, check-out/recibo, cargo aprobado.
- `likida/src/lib/correo/plantilla.ts` — shell alternativo con logo `cid:` embebido (tablas anidadas, CSS inline). Útil como segunda referencia de maquetado a prueba de clientes de correo viejos.
- `likida/src/lib/correo/avisos.ts` — catálogo de correos de producto como funciones puras (`avisoVigencias`, `avisoInvitacion`, etc.) — patrón de organización a copiar, no el contenido.

### 4.2 Correo — plantillas de autenticación (HTML estático, para pegar en el proveedor de correo)
- `atiende-restaurantes/docs/correo-auth/magic-link.html` — adaptar si se implementa LAUNCH-014.
- `atiende-restaurantes/docs/correo-auth/cambio-de-correo.html` — adaptar para LAUNCH-007 (cambio de correo).
- `likida/docs/correo-auth/magic-link.html`, `confirmar-alta.html`, `invitacion.html` (clave para LAUNCH-006), `recuperar-acceso.html` (clave para LAUNCH-008), `cambio-de-correo.html`, `reautenticacion.html`, `aviso-contrasena.html`, `aviso-correo-cambiado.html`, `aviso-telefono-cambiado.html`, `aviso-identidad-ligada.html`, `aviso-identidad-quitada.html`, `aviso-segundo-factor-agregado.html`, `aviso-segundo-factor-quitado.html` — set más completo de los dos hermanos; Hoteles necesita sobre todo `invitacion.html` y `recuperar-acceso.html` de este set.

### 4.3 Correo — ventas/prospección
- `atiende-restaurantes/docs/correo-ventas/prospeccion.html` — plantilla B2B con placeholders `{{RESTAURANTE}}`, `{{CONTACTO}}`, `{{LIGA_AGENDA}}`. Adaptar a `{{HOTEL}}`/`{{CONTACTO}}` para prospección de hoteles (soporta LAUNCH-025/027).

### 4.4 Legales — textos base
- `atiende-restaurantes/src/pages/Privacidad.tsx` — patrón recomendado: marca explícitamente los datos legales faltantes (razón social, domicilio) con un componente `FaltaDato` en vez de inventarlos. Copiar ese patrón, no solo el texto.
- `atiende-restaurantes/src/pages/Terminos.tsx`, `src/pages/legal/LegalPage.tsx` — layout compartido.
- `likida/src/app/terminos/page.tsx` — incluye cláusula de IA determinística y deslinde fiscal, útil como referencia para la cláusula de IA que le falta a Hoteles (LAUNCH-019).
- `likida/src/app/aviso/[tenant]/page.tsx` — patrón de aviso LFPDPPP dinámico por tenant, directamente aplicable a "aviso por hotel" (soporta LAUNCH-018).
- `likida/docs/legal/00-CHECKLIST-ENTERPRISE.md`, `01-DPA-PLANTILLA.md`, `02-SLA-PLANTILLA.md`, `03-ANEXO-SEGURIDAD-PLANTILLA.md`, `04-SUBENCARGADOS-PLANTILLA.md` — genéricos de SaaS B2B mexicano, mínimo ajuste necesario (soporta LAUNCH-024).

### 4.5 Marca/diseño (documentos maestros, no HTML — referencia de metodología)
- `likida/MARCA.md` — voz "honesto-fiscal", frases prohibidas explícitas (nunca prometer cifras sin fuente), 3 paletas documentadas, reglas del logo. El patrón de "frases prohibidas" es directamente portable a un `MARCA.md` de Hoteles.
- `likida/DESIGN.md` — sistema de diseño v3.1, kit compartido (`admin/ui/kit.tsx`), anatomía de página estándar. Hoteles ya usa `packages/ui` con un patrón similar (`ThemeSelector`, `StatCard`) — este documento sirve para formalizarlo por escrito.
- `likida/src/app/admin/ui/kit.tsx` — componentes primitivos (`KpiTile`, `StatusPill`, `Semaphore`, `ChartCard`) reutilizables como inspiración para `packages/ui`.

### 4.6 Documentación de demo/ventas
- `likida/docs/conocimiento/guion-demo.md` — guion de demo comercial.
- `atiende-restaurantes/docs/audits/demo-readiness-2026-09-04.md` — checklist corto de "GO condicionado" con hallazgos AG-01…UI-01, formato más barato de portar que el de Likida.
