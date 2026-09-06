# Inventario de frontend — repo de referencia `atiende-restaurantes`

Fuente: `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes` (solo lectura, sin `.env`/`.git`/`.vercel`/secretos). Stack: **Vite 8 + React 18 + TypeScript + shadcn/ui (Radix) + Tailwind 3**, Supabase como backend. Todas las rutas de archivo abajo son relativas a esa raíz salvo que se indique lo contrario.

---

## 1. Identidad visual

### 1.1 Logo — `src/components/AtiendeLogo.tsx`

Es una **reconstrucción vectorial en SVG inline**, no un asset importado (el propio comentario del archivo lo dice: "No tengo el archivo original — esto es una reconstrucción fiel al mismo mark, no el asset").

- `AtiendeMark({ className = "h-7 w-auto", animado = false })`: `<svg viewBox="0 0 40 32">` con 3 `<rect>` ("líneas de movimiento", `#7DD3FC`), un `<circle>` ("cabeza", `#38BDF8`) y un `<path>` de trazo grueso (`stroke="#1D4ED8"`, `strokeWidth={7}`, `strokeLinecap/Linejoin="round"`) que dibuja una figura corriendo. Con `animado=true` añade la clase `atiende-glifo-animado`, que anima cada `.atiende-linea-{1,2,3}` con `@keyframes atiende-linea-correr` (cascada, delays 0/0.15/0.3s, gateado por `prefers-reduced-motion`).
- `AtiendeWordmark({ className, markClassName, animado })`: envuelve `AtiendeMark` + `<span className="font-display text-2xl font-bold tracking-tight" style={{ color: "#1D4ED8" }}>atiende</span>`.
- Uso real: `favicon.svg` (`public/favicon.svg`) es el mismo dibujo estático (mismos colores hex). Se usa en `AdminSidebar`, `RepartidorSidebar`, `AdminLogin`, `SuperAdminDashboard`, `ModalClonarVoz`, `ModalFormularioElegante/Lateral`, pantalla de carga (`.atiende-respira`).
- No hay variantes de tamaño con props aparte de `className`/`markClassName` (todo vía Tailwind clases pasadas desde fuera).

### 1.2 Tipografías

Declaradas en `tailwind.config.ts` → `theme.extend.fontFamily`:

```
display: ["Inter Tight", "sans-serif"]
body:    ["Inter", "sans-serif"]
menu:    ["Inter", "sans-serif"]
mono:    ["IBM Plex Mono", "ui-monospace", "monospace"]
```

Comentario explícito en el config: *"Same type trio as [consola de referencia] (Inter / Inter Tight / IBM Plex Mono), per the design-system port — only the color tokens changed, not the type system."*

Carga: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');` como **primera línea de `src/index.css`**, más `<link rel="preconnect">` a `fonts.googleapis.com`/`fonts.gstatic.com` en `index.html`.

Fuentes adicionales **solo para el login** (`src/pages/login.css`, no globales): `Fraunces` (serif, para el titular `.login-serif`) e `Instrument Sans` (sans, `.login-btn`/`.login-campo`), cargadas con su propio `@import` en ese archivo. `.login-kicker` reutiliza `IBM Plex Mono`.

Pesos usados: Inter 400/500/600/700, Inter Tight 500/600/700, IBM Plex Mono 400/500, Fraunces 400 (variable, un solo peso), Instrument Sans 400/500/600.

### 1.3 Tokens de color — `src/index.css` (bloque `@layer base`)

Sistema documentado en el propio archivo como **"white / blue / sky-blue"**, adaptado de un sistema de referencia (blanco/negro/gris → blanco/azul/azul-cielo), con hex de referencia en el comentario:
`bg #f7f9fc · surface #ffffff · ink #0f1b2d · muted #5b6b82 · line #e2e8f0 · accent (blue) #1d4ed8 · secondary (sky) #0ea5e9 · bad #c0122a`.

**Light (`:root`)** — valores HSL tal cual (formato `H S% L%`, para usar con `hsl(var(--x))`):

| Token | Valor HSL |
|---|---|
| `--background` | `210 40% 98%` |
| `--foreground` | `216 50% 12%` |
| `--card` / `--popover` | `0 0% 100%` |
| `--card-foreground` / `--popover-foreground` | `216 50% 12%` |
| `--primary` | `224 76% 48%` |
| `--primary-foreground` | `0 0% 100%` |
| `--secondary` | `224 76% 48%` (= primary) |
| `--secondary-foreground` | `0 0% 100%` |
| `--muted` | `210 30% 95%` |
| `--muted-foreground` | `215 18% 43%` |
| `--accent` | `224 76% 48%` (= primary) |
| `--accent-foreground` | `0 0% 100%` |
| `--destructive` | `352 83% 41%` |
| `--destructive-foreground` | `0 0% 100%` |
| `--border` / `--input` | `214 32% 91%` |
| `--ring` | `224 76% 48%` |
| `--radius` | `0.75rem` |
| `--gold` | `199 89% 48%` |
| `--gold-foreground` | `0 0% 100%` |
| `--terracotta` | `224 76% 48%` |
| `--terracotta-light` | `199 89% 48%` |
| `--sand` | `210 30% 95%` |
| `--olive` | `224 76% 48%` |
| `--cream` | `210 40% 98%` |
| `--sidebar-background` | `0 0% 100%` |
| `--sidebar-foreground` | `216 50% 12%` |
| `--sidebar-primary` | `224 76% 48%` |
| `--sidebar-primary-foreground` | `0 0% 100%` |
| `--sidebar-accent` | `210 30% 95%` |
| `--sidebar-accent-foreground` | `224 76% 48%` |
| `--sidebar-border` | `214 32% 91%` |
| `--sidebar-ring` | `199 89% 48%` |

Nota: `gold/terracotta/sand/olive/cream` son **remanentes nominales de una paleta anterior** (mismo comentario del archivo: "Custom tokens (blue/sky-blue equivalents of the old gold/terracotta set)") — hoy todos resuelven a azul o al mismo neutro; no aportan matiz propio.

**Dark (`.dark`)**:

| Token | Valor HSL |
|---|---|
| `--background` | `216 45% 9%` |
| `--foreground` | `210 30% 95%` |
| `--card` | `216 40% 13%` |
| `--card-foreground` | `210 30% 95%` |
| `--popover` | `216 40% 11%` |
| `--popover-foreground` | `210 30% 95%` |
| `--primary` | `213 82% 62%` |
| `--primary-foreground` | `216 45% 9%` |
| `--secondary` | `199 89% 55%` |
| `--secondary-foreground` | `216 45% 9%` |
| `--muted` | `216 30% 18%` |
| `--muted-foreground` | `215 18% 65%` |
| `--accent` | `199 89% 55%` |
| `--accent-foreground` | `216 45% 9%` |
| `--destructive` | `352 75% 55%` |
| `--destructive-foreground` | `0 0% 100%` |
| `--border` / `--input` | `216 30% 20%` |
| `--ring` | `213 82% 62%` |

`.dark` **no** redefine `--gold/--terracotta/--sand/--olive/--cream/--sidebar-*` ni `--radius`/sombras/gradientes — en modo oscuro esos tokens siguen resolviendo a los valores light (deuda a tener en cuenta al portar).

Activación de dark mode: `darkMode: ["class"]` en `tailwind.config.ts`; la clase `.dark` la alterna `ThemeSelector` sobre `document.documentElement`.

**Radios** (`tailwind.config.ts` → `borderRadius`): `lg: var(--radius)` (0.75rem), `md: calc(var(--radius) - 2px)`, `sm: calc(var(--radius) - 4px)`. Además `rounded-full` (999px) es el radio real de botones/inputs (ver 1.5).

**Sombras** (`src/index.css` + mapeadas en `tailwind.config.ts` → `boxShadow`):
```
--shadow-card:     0 4px 24px -4px hsl(216 50% 12% / 0.08)
--shadow-elevated: 0 12px 40px -8px hsl(216 50% 12% / 0.15)
--shadow-glow:      0 0 40px hsl(224 76% 48% / 0.2)
```
Expuestas como utilidades `shadow-card`, `shadow-elevated`, `shadow-glow`.

**Gradientes** (custom properties, usados vía `bg-[image:var(--gradient-x)]` o directo en CSS):
```
--gradient-hero: linear-gradient(135deg, hsl(224 76% 48% / 0.95) 0%, hsl(199 89% 40%) 100%)
--gradient-gold: linear-gradient(135deg, hsl(199 89% 48%) 0%, hsl(199 89% 40%) 100%)
--gradient-warm: linear-gradient(180deg, hsl(210 40% 98%) 0%, hsl(0 0% 100%) 100%)
```
`.text-gradient-gold` (clase `@layer components`) usa `--gradient-gold` con `background-clip: text`. El botón `variant="hero"` usa `bg-[image:var(--gradient-gold)]`. El panel de login (`.login-lamina`) usa un gradiente hardcodeado `linear-gradient(135deg, #1D4ED8 0%, #0EA5E9 100%)` (no la variable).

**Animaciones/keyframes** (`src/index.css` `@layer utilities` + bloque final):
- `fadeUp`, `fadeIn`, `scaleIn`, `slideInRight` + clases `.animate-fade-up/in/scale-in/slide-in-right` y `.stagger-1..4` (delays 0.1–0.4s).
- `wave`, `waveSlide`, `waveFloat`, `float`, `wiggleFloat` (declaradas, uso puntual).
- `wiggle` también está duplicada en `tailwind.config.ts` (`keyframes.wiggle` + `animation.wiggle`, usada como utilidad Tailwind `animate-wiggle`).
- `accordion-down`/`accordion-up` (Radix Accordion, vía `tailwindcss-animate` + config propia).
- Micro-interacción global de botones: `button:not(:disabled):active { transform: scale(0.97) }` (80ms), gateada por `@media (prefers-reduced-motion: no-preference)`, aplicada a **todo** `<button>` del árbol, no solo al componente `Button`.
- `.card-interactive` (hover lift `-translateY(1px)` + `shadow-elevated`), opt-in, sin consumidores actuales.
- `atiende-respira` (pantalla de carga: opacidad 0.35↔1 + escala 0.985↔1, 1.6s, `cubic-bezier(0.22,1,0.36,1)`) y `atiende-linea-correr` (glifo animado del logo) — ambas con fallback `prefers-reduced-motion: reduce` (animación apagada, opacidad fija).
- `login-kenburns`/`login-revela`/`login-sube` en `login.css` (Ken Burns en la foto del login + entrada escalonada de cada bloque vía `.login-entra` + `animationDelay` inline).

---

## 2. Estructura de la app

### 2.1 Rutas — `src/App.tsx` (react-router-dom v7, `BrowserRouter`)

Todas las páginas son **lazy** (`lazyRoute` custom, con retry-una-vez si el chunk falla por caché de deploy corrupta):

| Ruta | Página | Archivo |
|---|---|---|
| `/` | Redirect con hash preservado a `/admin/login` | `RaizConHash` (inline en `App.tsx`) |
| `/admin/login` | Login | `src/pages/AdminLogin.tsx` |
| `/terminos` | Legal | `src/pages/Terminos.tsx` |
| `/privacidad` | Legal | `src/pages/Privacidad.tsx` |
| `/admin/superadmin` | Panel de plataforma (todos los tenants) | `src/pages/SuperAdminDashboard.tsx` |
| `/admin` | Panel del restaurante | `src/pages/AdminDashboard.tsx` |
| `/admin/repartidor/:userId` | Ficha de un repartidor desde admin | `src/pages/RepartidorAdminPanel.tsx` |
| `/repartidor` | App del repartidor | `src/pages/RepartidorDashboard.tsx` |
| `*` | 404 | `src/pages/NotFound.tsx` |

`vite.config.ts` fija `base: "/restaurantes/"` (deploy en subpath) — `App.tsx` usa `basename={import.meta.env.BASE_URL.replace(/\/$/, "")}`.

No es una landing pública: `index.html` lleva `<meta name="robots" content="noindex, nofollow">` a propósito (panel interno con login).

Providers globales en `App.tsx`: `QueryClientProvider` (TanStack Query), `TooltipProvider` (Radix), `Toaster` (shadcn) + `Sonner` (segundo sistema de toasts, en paralelo), `RouteErrorBoundary` (class component, limpia `sessionStorage`+`caches` y recarga), `Suspense` con `LoadingScreen` (spinner + `aria-busy`).

### 2.2 Sidebar de administración — `src/components/admin/AdminSidebar.tsx`

- Estructura calcada de un panel de referencia externo (comentario: "Estructura calcada de la anatomía real del panel de restaurantes de Rappi (INICIO/MARKETING/ADMINISTRAR/SOPORTE)").
- Grupos (`menuSections`, array de `{title, siempreAbierto?, items:[{id,label,icon,disabled?}]}`):
  - **ANÁLISIS** (`siempreAbierto: true`, no colapsa): Estadísticas (`dashboard`), Pregunta a tus datos (`pregunta`).
  - **INICIO**: Notificaciones, Pedidos (`orders`), Historial de Órdenes, Pagos (`disabled: true`, badge "Pronto").
  - **AGENTES**: Agente de voz, Agente de WhatsApp.
  - **MARKETING**: Promociones.
  - **ADMINISTRAR**: Productos, Categorías, Clientes (`users`), Repartidores, Sucursales, Cuentas & Accesos.
- Acordeón: solo un grupo (aparte de ANÁLISIS) abierto a la vez, recordado en `localStorage` (`atiende-sidebar-grupo-abierto`); al montar abre el grupo de la sección activa o "INICIO" por defecto.
- Colapso ancho (`w-60` ↔ `w-16`) con estado local `collapsed` (no persistido); icon-only cuando colapsado.
- Pie: bloque `bg-muted/60` con "Centro de ayuda" + "Mi perfil"/"Plan y facturación"/"Configuración" (sin handlers reales, solo visual) + `ThemeSelector` centrado; luego, separado por `border-t`, el chip de usuario (avatar con inicial, email, rol "Administrador", botón logout).
- Solo visible en desktop (`hidden md:flex`) — **no hay drawer/Sheet equivalente para mobile**; en mobile, `AdminDashboard` solo muestra un header simple (ver 2.5).

### 2.3 Sidebar de repartidor — `src/components/repartidor/RepartidorSidebar.tsx`

- Mismo shell (`bg-card border rounded-2xl sticky`, `w-64`↔`w-16`), pero con `border-b` bajo el logo (a diferencia de Admin, que no lleva línea) y grupos sin acordeón: RESUMEN (Panel), ENTREGAS (Pendientes/En Camino con badge numérico rojo, Historial), CUENTA (Perfil).
- Badges de conteo (`pendingCount`/`activeCount`) como círculo `bg-destructive` sobre el ítem, o invertido (`bg-primary-foreground text-primary`) si el ítem está activo.
- Usa `ScrollArea` (shadcn) para el nav, a diferencia de `AdminSidebar` que usa `overflow-y-auto` plano.
- También `hidden md:flex` — el repartidor tiene su propia navegación mobile independiente (ver 2.6), no reutiliza esta sidebar.

### 2.4 Temas — `src/components/ThemeSelector.tsx`

- 3 opciones: `claro` / `sistema` / `oscuro`, persistidas en `localStorage` (`atiende-tema`).
- `sistema` resuelve una sola vez contra `prefers-color-scheme` y se re-evalúa en `change` del `matchMedia` **solo si** el usuario sigue en modo "sistema" — nunca oscurece la app solo porque el SO esté oscuro sin elección explícita.
- UI: `role="radiogroup"` con 3 `<button role="radio" aria-checked>`, iconos `Sun/Monitor/Moon` de `lucide-react`, contenedor píldora (`rounded-full bg-muted`).
- No usa `next-themes` (está en `package.json` como dependencia pero este selector es 100% custom).

### 2.5 Auth flow

- `src/pages/AdminLogin.tsx`: Supabase Auth con dos métodos — **Google OAuth** (`signInWithOAuth`) y **magic link por email** (`signInWithOtp`), con un allowlist hardcodeado de un solo email admin (`ADMIN_EMAIL`) para el flujo de OTP por formulario. Maneja manualmente el hash del magic link (`access_token`/`refresh_token`) por una condición de carrera documentada con `detectSessionInUrl`, y también `error_description` del hash para links caducados (toast). Tras login, `routeAfterAuth()` consulta `user_roles` y decide `/admin/superadmin` vs `/admin`.
- Hooks de rol: `src/hooks/useUserRole.ts` (`{roles, isAdmin, isRepartidor, isUser, loading}`, roles: `admin|user|repartidor`) y `src/hooks/useIsAdmin.ts` (booleano simple, con suscripción a `onAuthStateChange`). Ambos consultan la tabla `user_roles` directo desde el cliente.
- No hay un guard de rutas centralizado (`ProtectedRoute`) visible en `App.tsx`: cada página resuelve su propio auth/rol internamente (patrón a mejorar/estandarizar al portar).

En mobile, `AdminDashboard` (línea ~2963) solo renderiza un `<header className="md:hidden">` (logo + botón logout) — el bloque completo de contenido (`<div className="hidden md:flex flex-1 ...">`) es **desktop-only**. Es decir: **el panel admin de restaurantes no tiene una experiencia mobile real**, solo un stub de header.

### 2.6 Responsive / mobile — `src/hooks/use-mobile.tsx`

- `useIsMobile()`: `matchMedia(max-width: 767px)`, breakpoint `768px`, usado por el primitivo `sidebar.tsx` de shadcn (que **no está en uso** — ver 3.5) y por `Sheet`/`Drawer` internamente vía Radix.
- El único flujo con mobile bien resuelto es `RepartidorDashboard.tsx`: header fijo `md:hidden` arriba + bottom-nav fija `md:hidden` abajo (Inicio/Pendientes/En Camino/Efectivo/Historial, con badges), `main` con `pt-16 pb-24` en mobile vs `md:pt-8 md:pb-8` en desktop, y `safe-area-top`/`safe-area-bottom` (utilidades para notch/home-indicator, no viene en el CSS leído — probablemente clase custom o de Tailwind plugin no listado; **verificar antes de portar**).

### 2.7 Estados vacíos/carga/error

- Loading global de rutas: `LoadingScreen` en `App.tsx` (spinner `animate-spin` + texto "Cargando panel…", `aria-busy="true"`).
- Loading de `AdminDashboard`: `if (loading) return <div role="status" aria-label="Cargando"><AtiendeMark className="atiende-respira" /></div>` — el logo "respira" en vez de un spinner genérico.
- Error boundary de rutas: `RouteErrorBoundary` en `App.tsx`, UI con `role="alert"`, título + explicación + botón "Limpiar caché y recargar" (borra `sessionStorage` y `caches`).
- Vacíos: patrón textual "Sin datos" / "Sin datos aún" en vez de simular cifras (ver comentario de `ClientesSection.tsx`: "Cuando no hay datos suficientes ... se muestra 'Sin datos' en vez de simular una cifra" — disciplina de producto documentada, no un componente `EmptyState` reutilizable dedicado).
- Loaders puntuales: `Loader2` (lucide, `animate-spin`) usado inline en botones/secciones async (`ClientesSection`, `AdminDashboard`, etc.) — no hay un componente `Spinner` propio, siempre es el icono lucide + `animate-spin`.
- `Skeleton` (`src/components/ui/skeleton.tsx`, shadcn estándar) existe en el catálogo pero no se confirmó uso extendido fuera de `ui/sidebar.tsx`.

### 2.8 Accesibilidad observada

- Puntos positivos concretos: `role="status"`/`aria-busy`/`aria-label` en loaders; `role="alert"` en el error boundary; `role="radiogroup"`/`role="radio"`/`aria-checked`/`aria-label` en `ThemeSelector`; `<label htmlFor>` + `sr-only` en el input de email del login; `prefers-reduced-motion` respetado en todas las animaciones custom (glifo, respira, botones, login).
- Hallazgo de auditoría propia del repo (`docs/audits/enterprise-remediation-2026-09-04.md`, fila 5 "Frontend y experiencia", severidad 7, estado "corregido local"): *"Rutas lazy, smoke de navegador y budgets automáticos. **Falta E2E autenticado/a11y/dispositivos**."* — es decir, el propio equipo reconoce que no hay pruebas de accesibilidad automatizadas ni matriz de dispositivos, solo smoke tests de navegador (`scripts/e2e-ui-smoke.py`, `scripts/e2e_smoke.py`).
- No se encontró uso de `aria-live` para las notificaciones/toasts (Sonner/Radix Toast internamente sí manejan roles ARIA de forma nativa, pero no hay refuerzo custom visible).
- El panel admin no accesible en mobile (ver 2.5/2.6) es en sí mismo un hallazgo de accesibilidad/usabilidad a resolver en hoteles si se espera uso desde tablet/celular en recepción.

---

## 3. Catálogo de componentes reutilizables

### 3.1 Marca / tema
- `src/components/AtiendeLogo.tsx` — `AtiendeMark({className, animado})`, `AtiendeWordmark({className, markClassName, animado})`.
- `src/components/ThemeSelector.tsx` — `ThemeSelector()`, sin props (lee/escribe `localStorage` directo).

### 3.2 Layout de panel
- `src/components/admin/AdminSidebar.tsx` — `AdminSidebar({user, activeSection, onSectionChange, onLogout})`.
- `src/components/repartidor/RepartidorSidebar.tsx` — `RepartidorSidebar({user, activeSection, onSectionChange, onLogout, pendingCount?, activeCount?})`.
- Sidebar de `SuperAdminDashboard.tsx` — **inline**, no extraído a componente propio (línea ~288 del archivo).

### 3.3 Widgets de cifras — `src/components/admin/ui/StatCard.tsx`
- `StatCard({icon, label, value, nota?, verMas?})` — anatomía "plataforma": caja interna `bg-muted`, chip de icono sólido `bg-primary`, cifra grande `font-display`, pie opcional bajo hairline **punteado** (color verde/rojo/neutro según si `nota` empieza con `+`/`-`).
- `TrendStatCard({icon, label, value, deltaPct?, deltaLabel?, onVerMas?})` — anatomía "cuenta": chip `bg-primary/10`, link "Ver más" arriba a la derecha, pie en píldora de color con `TrendingUp/TrendingDown` + `%` de variación.
- Usados en `AdminDashboard.tsx`, `SuperAdminDashboard.tsx` (`dist/assets/StatCard-*.js` confirma que es un chunk separado en build).

### 3.4 Secciones de administración (`src/components/admin/*.tsx`, todas autocontenidas: fetch propio a Supabase, sin depender de estado del padre salvo `restaurantId`/callbacks puntuales)

| Archivo | Líneas | Responsabilidad |
|---|---|---|
| `ClientesSection.tsx` | 882 | CRM de clientes (`customers`/`customer_addresses`), tiers por percentil (BLACK/PLATINUM/GOLD/BLUE) configurables por constantes, importación Excel (`xlsx`), `StatCard`. |
| `HistorialOrdenesSection.tsx` | 526 | Listado paginado de `orders` con filtros server-side (rango de fecha vía `Calendar`+`Popover`, sucursal, "no entregados"), export a Excel/PDF (`jspdf`+`jspdf-autotable`). |
| `NotificacionesSection.tsx` | 1022 | Centro de notificaciones con tabs horizontales + indicador deslizante animado (`framer-motion`), preferencias de notificación por tipo de evento (`Switch`). |
| `PedidoDetalleSection.tsx` | 323 | Vista de página completa (no modal) del detalle de un pedido, reutilizada desde Historial/Pedidos/Notificaciones/panel repartidor — solo recibe `pedidoId` + callback "volver". |
| `PedidosSection.tsx` | 857 | Flujo de despacho Recibidas→Enviadas + Programadas, mapa Leaflet con marcador de sucursal real + repartidor simulado. |
| `SelectorIdiomasAgente.tsx` | 303 | Selector multi-idioma estilo ElevenLabs con banderas, autocontenido contra edge function `agent-config`. |
| `SucursalesSection.tsx` | 973 | CRUD de sucursales (horario, switches de canal IA activo por sucursal, baja reversible vía `is_active=false`), mapa Leaflet para lat/lng. |
| `WhatsAppAgenteConfigSection.tsx` | 363 | Editor de prompt/tono/modelo/temperatura del agente de WhatsApp contra tabla propia. |

### 3.5 Modales / shells reutilizables
- `src/components/ModalFormularioElegante.tsx` — shell simple (icono centrado arriba, barra de gradiente, `CampoFormulario` helper) para formularios de una pantalla. **Legacy**, se mantiene para quien ya lo use.
- `src/components/ModalFormularioLateral.tsx` — shell "riel izquierdo + columna derecha" (mismo esqueleto que `ModalClonarVoz`), es el shell actual preferido; usado por `ModalProducto`, `ModalCategoria`, `ModalCuenta`, `ModalRepartidor`.
- `src/components/ModalClonarVoz.tsx` (540 líneas) — flujo completo de clonación de voz (ElevenLabs Instant Voice Cloning) con grabación en navegador o subida de archivo.
- `src/components/ModalProducto.tsx`, `ModalCategoria.tsx`, `ModalCuenta.tsx`, `ModalRepartidor.tsx` — formularios CRUD autocontenidos (fetch/insert/update propios, el padre solo pasa `restaurantId` + entidad a editar + callback).
- `src/components/WidgetWhatsApp.tsx` (263 líneas) — widget de chat flotante para demo pública, conecta a la edge function `whatsapp-widget-chat` (mismo cerebro que el canal real).
- `src/components/CampoPixeles.tsx` (119 líneas) — canvas animado de fondo ("nube de píxeles") para la sección "Pregunta a tus datos"; puerto directo de un componente de referencia externo, sin dependencias de librería (canvas nativo).

### 3.6 Primitivos shadcn/ui (`src/components/ui/*`, 43 archivos)

Set estándar shadcn (estilo "default", `baseColor: slate`, `cssVariables: true`, sin prefijo — ver `components.json`): `accordion, alert, alert-dialog, animated-tabs*, aspect-ratio, avatar, badge, breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, credit-card*, dialog, direction-aware-hover*, drawer, dropdown-menu, form, hover-card, input, input-otp, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, scroll-cards*, select, separator, sheet, sidebar (no usado, ver abajo), skeleton, slider, sonner, switch, table, tabs, textarea, toast, toaster, toggle, toggle-group, tooltip, use-toast, word-pull-up*`. (`*` = no son shadcn estándar, son añadidos custom del proyecto con ese mismo patrón de archivo).

Detalles de los pedidos explícitamente revisados:
- **`button.tsx`**: variantes `default/destructive/outline/secondary/ghost/link/hero/terracotta/gold`; tamaños `default/sm/lg/xl/icon`. Base **siempre `rounded-full`** (píldora 999px) en todos los tamaños — documentado como "anatomía de píldora" portada de un sistema de referencia; feedback de press (`scale(0.97)`) es global vía CSS, no por variante.
- **`card.tsx`**: `Card/CardHeader/CardTitle/CardDescription/CardContent/CardFooter`, shadcn de fábrica sin personalizar (`rounded-lg border bg-card shadow-sm`).
- **`badge.tsx`**: variantes `default/secondary/destructive/outline`, shadcn de fábrica.
- **`table.tsx`**: shadcn de fábrica (`Table/TableHeader/TableBody/TableFooter/...`).
- **`dialog.tsx`** y **`sheet.tsx`**: Radix Dialog envuelto, shadcn de fábrica (sheet con variantes `side: top/bottom/left/right`).
- **`sidebar.tsx`** (637 líneas, primitivo completo de navegación colapsable de shadcn con `SidebarProvider`, cookie de estado, atajo `⌘/Ctrl+B`, `Sheet` en mobile): **confirmado sin ningún import en el resto de `src`** (`grep` no encontró consumidores) — el proyecto implementó `AdminSidebar`/`RepartidorSidebar` a mano en su lugar. **No asumir que se usa; es candidato a eliminar o a adoptar de cero si conviene el primitivo real en hoteles.**

---

## 4. Dependencias, scripts y config

### 4.1 `package.json` — dependencias de frontend relevantes (versiones exactas)

```
react ^18.3.1 · react-dom ^18.3.1 · react-router-dom ^7.18.3
@tanstack/react-query ^5.83.0
@radix-ui/react-{accordion,alert-dialog,aspect-ratio,avatar,checkbox,collapsible,
  context-menu,dialog,dropdown-menu,hover-card,label,menubar,navigation-menu,
  popover,progress,radio-group,scroll-area,select,separator,slider,slot,switch,
  tabs,toast,toggle,toggle-group,tooltip} (rango 1.1.x–2.2.x, ver archivo para exactos)
class-variance-authority ^0.7.1 · clsx ^2.1.1 · tailwind-merge ^2.6.0 · tailwindcss-animate ^1.0.7
lucide-react ^0.462.0
cmdk ^1.1.1 · vaul ^0.9.9 · input-otp ^1.4.2 · react-resizable-panels ^2.1.9
react-hook-form ^7.61.1 · @hookform/resolvers ^3.10.0 · zod ^3.25.76
date-fns ^3.6.0 · react-day-picker ^8.10.1
recharts ^2.15.4
embla-carousel-react ^8.6.0 · embla-carousel-autoplay ^8.6.0
framer-motion ^12.23.25
leaflet ^1.9.4 · @types/leaflet ^1.9.22
sonner ^1.7.4 · next-themes ^0.3.0 (declarada, no usada por ThemeSelector custom)
jspdf ^4.2.1 · jspdf-autotable ^5.0.8 · xlsx (tarball de cdn.sheetjs.com, no npm registry)
@supabase/supabase-js ^2.86.0 · @elevenlabs/client ^1.23.0
```

### 4.2 devDependencies relevantes
```
vite ^8.2.2 · @vitejs/plugin-react-swc ^4.3.3 · typescript ^5.8.3
tailwindcss ^3.4.17 · @tailwindcss/typography ^0.5.16 · postcss ^8.5.6 · autoprefixer ^10.4.21
eslint ^9.32.0 · typescript-eslint ^8.38.0 · eslint-plugin-react-hooks ^5.2.0 · eslint-plugin-react-refresh ^0.4.20
lovable-tagger ^1.3.3 (solo en modo dev, ver vite.config.ts)
```

### 4.3 Scripts npm (`package.json`)
```
dev, build, build:dev (--mode development), build:budget (build + check-bundle-budget.mjs),
lint, typecheck (tsc --noEmit), test (= test:edge), test:edge (deno test),
qa:voice-widget, check:edge (deno check), test:db (supabase/tests/run-local.sh),
quality (lint + typecheck + test:edge + check:edge + build:budget), preview
```

### 4.4 Config relevante
- **`vite.config.ts`**: `base: "/restaurantes/"` (⚠️ cambiar a algo tipo `/hoteles/` o raíz según deploy), plugin React SWC, `@` → `./src`, `chunkSizeWarningLimit: 600`, `manualChunks` explícito por familia de dependencia pesada (`spreadsheet`=xlsx, `charts`=recharts/d3, `maps`=leaflet, `voice-livekit-*`, `voice-elevenlabs`, `motion`=framer-motion, `app-platform`=supabase+radix).
- **`tailwind.config.ts`**: `darkMode: ["class"]`, `content` apunta a `pages/components/app/src` con `.{ts,tsx}`, `container.center + padding 1.5rem + 2xl:1400px`, plugin `tailwindcss-animate`. Ver colores/radios/sombras/animaciones ya documentados en §1.
- **`components.json`** (shadcn): `style: "default"`, `baseColor: "slate"`, `cssVariables: true`, `prefix: ""`, alias `@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`.
- **`tsconfig.app.json`**: `target ES2020`, `jsx: react-jsx`, `strict: false`, `noUnusedLocals/Parameters: false`, `noImplicitAny: false` — TypeScript deliberadamente permisivo, no estricto.
- **`eslint.config.js`** (flat config): ignora `dist` y `supabase/functions`; `@typescript-eslint/no-unused-vars: off`, `@typescript-eslint/no-explicit-any: "warn"` (con comentario: deuda visible pero no bloqueante), `react-refresh/only-export-components: warn`.
- **`postcss.config.js`**: solo `tailwindcss` + `autoprefixer`.

### 4.5 `public/` — assets (nombres y formatos exactos)
```
public/favicon.svg          — SVG, 508 bytes, mismo dibujo que AtiendeMark
public/placeholder.svg      — SVG genérico shadcn/Lovable (3253 bytes)
public/images/login-hero.png — PNG, 1.37 MB (foto de fondo del panel de login)
public/media/orbe-agente.mp4 — MP4, 864 KB (video, probable widget de voz)
public/robots.txt
```

---

## 5. Propuesta de adaptación a hoteles

Mapa de navegación propuesto (sidebar hoteles) → componente de restaurantes reutilizable como base, y qué falta construir desde cero:

| Sección hoteles | Base en restaurantes | Reutilizable tal cual | Falta |
|---|---|---|---|
| **Resumen** | `AdminDashboard.tsx` sección `dashboard` + `StatCard`/`TrendStatCard` | Layout de panel, `StatCard`/`TrendStatCard`, `CampoPixeles` (si se quiere el hero "pregunta a tus datos") | KPIs propios de hotel (ocupación, ADR, RevPAR) — no existen en restaurantes |
| **Reservas** | `PedidosSection.tsx` (flujo Recibidas→Enviadas) y `HistorialOrdenesSection.tsx` (filtros server-side, export Excel/PDF) como *patrón* | Estructura de tabs/estado, filtros de fecha (`Calendar`+`Popover`), export `jspdf`/`xlsx` | Todo el dominio (reserva vs pedido): fechas de estancia, tarifas, canales (OTA/directo), estado de pago — modelo de datos nuevo |
| **Disponibilidad/Habitaciones** | Ninguno directo; `SucursalesSection.tsx` da el patrón de CRUD con mapa/horario/switches | Patrón CRUD + `ModalFormularioLateral` | Calendario de disponibilidad, tipos de habitación, tarifario — construir desde cero |
| **Huéspedes** | `ClientesSection.tsx` (CRM, tiers, import Excel, `StatCard`) | Muy reutilizable: estructura de tabla+tiers+import es directamente portable renombrando "cliente"→"huésped" | Historial de estancias en vez de historial de pedidos |
| **Recepción/Check-in-out** | `PedidoDetalleSection.tsx` (vista de página completa reutilizada) como *patrón* de detalle | Patrón de "vista de detalle en página, no modal" | Flujo de check-in/out real, no existe equivalente |
| **Housekeeping** | Ninguno | — | Construir desde cero (no hay analogía en restaurantes) |
| **Mantenimiento** | Ninguno | — | Construir desde cero |
| **A&B (alimentos y bebidas)** | Todo el dominio de restaurantes (`PedidosSection`, menú, `ModalProducto`/`ModalCategoria`) | Alto: es literalmente el dominio de este repo | Adaptar a "servicio a cuarto"/POS de hotel en vez de delivery |
| **Mensajería/Agentes** | `WhatsAppAgenteConfigSection.tsx`, `SelectorIdiomasAgente.tsx`, `ModalClonarVoz.tsx`, `WidgetWhatsApp.tsx` | Muy reutilizable: la infraestructura de agentes de voz/WhatsApp es agnóstica al vertical | Prompts/tools específicos de hotel (ya fuera del alcance frontend) |
| **Reputación** | `NotificacionesSection.tsx` (patrón de tabs + centro de eventos) como *patrón* | Estructura de tabs con indicador animado | Integración con reviews (Google/Booking/TripAdvisor) — no existe |
| **Back office** | `SuperAdminDashboard.tsx` (multi-tenant, `StatCard`, export) | Patrón de dashboard de plataforma | Métricas financieras de hotel |
| **Configuración** | Bloque de cuenta en `AdminSidebar` (Mi perfil/Plan y facturación/Configuración — hoy sin handlers) + `ModalCuenta.tsx`/`ModalRepartidor.tsx` (alta de staff) | `ThemeSelector`, patrón de alta de cuentas de staff | Roles/permisos propios de hotel (recepción, housekeeping, gerencia) |

**Layout general**: `AdminSidebar.tsx` es la base más directa para el sidebar de hoteles (acordeón por grupo, colapsable, bloque de cuenta + `ThemeSelector`) — pero antes de portar, **hay que decidir si se resuelve el hueco de mobile** (hoy inexistente en el admin de restaurantes) dado que recepción/housekeeping probablemente necesitan tablet/celular.

---

## 6. Archivos a copiar tal cual vs. a adaptar

### 6.1 Copiar tal cual (sin secretos, infraestructura genérica)
```
tailwind.config.ts            (tokens de color/radio/sombra se REDEFINEN, pero la estructura del archivo sí se copia)
postcss.config.js
components.json
eslint.config.js
tsconfig.json / tsconfig.app.json / tsconfig.node.json
vite.config.ts                (cambiar `base` y revisar manualChunks según deps reales de hoteles)
src/lib/utils.ts               (helper `cn`)
src/hooks/use-mobile.tsx
src/hooks/use-toast.ts
src/components/ui/*.tsx        (los 43 primitivos shadcn — copiar todos salvo decidir descartar sidebar.tsx si no se adopta)
src/components/ThemeSelector.tsx
```

### 6.2 Adaptar (misma anatomía, contenido/dominio distinto)
```
src/index.css                  (mantener estructura de tokens/gradientes/sombras/animaciones; puede cambiarse la paleta si hoteles quiere otro acento, o mantenerse azul/cielo)
src/components/AtiendeLogo.tsx (mismo patrón SVG inline; logo propio de hoteles si aplica, o el mismo mark si es la misma marca atiende.ai)
public/favicon.svg             (regenerar si cambia el logo)
src/App.tsx                    (mismo patrón lazy+ErrorBoundary+rutas; rutas nuevas de hoteles)
src/components/admin/AdminSidebar.tsx  (mismo patrón de acordeón/colapso; menuSections nuevo, ver §5)
src/components/repartidor/RepartidorSidebar.tsx → base para sidebar de rol operativo de hotel si aplica (ej. housekeeping móvil)
src/components/admin/ui/StatCard.tsx   (reutilizable literal, solo cambian los datos que recibe)
src/components/ModalFormularioLateral.tsx / ModalFormularioElegante.tsx  (shells, reutilizables literales)
src/components/admin/ClientesSection.tsx → base para "Huéspedes"
src/components/admin/PedidosSection.tsx / HistorialOrdenesSection.tsx → base para "Reservas"
src/components/admin/NotificacionesSection.tsx → base para "Reputación"/centro de eventos
src/components/admin/SucursalesSection.tsx → base para "Habitaciones"/multi-propiedad
src/pages/AdminLogin.tsx + src/pages/login.css  (mismo flujo de auth; cambiar copy/imagen hero)
src/pages/SuperAdminDashboard.tsx → back office multi-hotel
```

### 6.3 No portar / evaluar antes
```
src/components/ui/sidebar.tsx   — confirmado SIN uso en el repo de referencia; no copiar salvo decisión explícita de adoptar el primitivo real de shadcn en vez del sidebar custom.
src/components/CampoPixeles.tsx — efecto decorativo puntual; opcional, no crítico.
src/components/WidgetWhatsApp.tsx / ModalClonarVoz.tsx / SelectorIdiomasAgente.tsx — dependen de infraestructura de agentes (ElevenLabs/edge functions) fuera del alcance de este inventario de frontend puro; portar junto con esa infraestructura, no antes.
public/media/orbe-agente.mp4, public/images/login-hero.png — assets de marca del piloto de restaurantes; reemplazar por assets propios de hoteles.
```
