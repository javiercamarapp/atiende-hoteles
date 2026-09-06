# @atiende/web — Panel de Atiende Hoteles (H3)

Frontend del panel hotelero. Stack: Vite 8 + React 18 + TypeScript 5.8 +
Tailwind 3.4 + react-router v7 + TanStack Query v5 — mismas versiones
mayores que `atiende-restaurantes` (ver `docs/referencia/05-frontend-restaurantes.md`
y ADR-002 en `docs/ARQUITECTURA.md`). Identidad visual (logo, tokens,
tipografía, sidebar) portada desde ese repo vía `packages/ui`.

## Cómo correr

Desde la raíz del monorepo (`npm install` ya resuelve los workspaces):

```bash
npm install                # una vez, desde la raíz
npm run dev --workspace apps/web      # http://localhost:5173
npm run build --workspace apps/web    # tsc --noEmit + vite build → apps/web/dist
npm run typecheck --workspace apps/web
npm run lint --workspace apps/web
```

O directamente dentro de `apps/web/`:

```bash
cd apps/web
npm run dev
npm run build
npm run typecheck
npm run lint
npm run e2e          # Playwright, Chrome del sistema (channel: 'chrome')
```

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `VITE_API_URL` | No (pero sin ella todas las pantallas muestran `EstadoError` honesto) | Base URL del backend Hono (ADR-004), ej. `http://localhost:8787`. Sin backend disponible, `src/lib/api.ts` lanza `ApiUnavailableError` y cada pantalla lo captura con `EstadoError`/`EstadoVacio` — nunca se muestran datos de ejemplo. |

Crea un `.env.local` (ignorado por git) si necesitas apuntar a un backend real:

```
VITE_API_URL=http://localhost:8787
```

## Estructura

- `src/lib/api.ts` — cliente tipado de la API (auth, hoteles, resumen, reservas, disponibilidad, huéspedes, recepción, tickets housekeeping/mantenimiento, A&B, mensajería, reputación, back office, configuración).
- `src/hooks/useAuth.tsx` — sesión (JWT propio, ADR-004) + guard de rutas `RutaProtegida`.
- `src/hooks/useHotel.tsx` — selector de hotel activo (multi-hotel, `org → location`).
- `src/layouts/AppShell.tsx` — sidebar hotelero (desktop) + `BottomNav`/`MobileHeader` (móvil real, cierra el hueco de `atiende-restaurantes` documentado en 05§2.5/§2.6).
- `src/pages/*` — una pantalla por ruta: `/resumen`, `/reservas`, `/disponibilidad`, `/huespedes`, `/recepcion`, `/housekeeping`, `/mantenimiento`, `/alimentos-bebidas`, `/mensajeria`, `/reputacion`, `/back-office`, `/configuracion`, más `/login`, `/terminos`, `/privacidad` y 404.
- `packages/ui` (`@atiende/ui`, alias resuelto directo al código fuente, sin paso de build) — tokens (`index.css`), preset de Tailwind, `AtiendeLogo`, `ThemeSelector`, `Sidebar`, `BottomNav`, `StatCard`/`TrendStatCard`, `EstadoVacio`/`EstadoError`/`EstadoCargando`, primitivos shadcn.

## Disciplina "nunca inventar una cifra" (REQ-UX-002)

Ninguna pantalla muestra `0` o un dato simulado cuando no hay backend/credenciales.
`StatCard`/`TrendStatCard` aceptan una prop `sinDato` que fuerza un guion (`—`)
con la razón explícita; `EstadoError` nombra la integración y declara
`pendienteCredenciales` cuando aplica; `EstadoVacio` se usa cuando la
respuesta es válida pero está vacía.

## Pruebas E2E (Playwright)

Config en `apps/web/playwright.config.ts`, specs en `tests/e2e/` (raíz del
repo). Usa `channel: 'chrome'` (Chrome del sistema, sin descargar
navegadores). Dos proyectos: `desktop` (1280×800) y `mobile` (390×844).

- `tests/e2e/paridad-visual.spec.ts` — captura login/resumen/reservas en ambos viewports → `tests/e2e/screenshots/hoteles-*.png`.
- `tests/e2e/axe-accesibilidad.spec.ts` — `@axe-core/playwright` sobre las mismas 3 rutas, falla si hay violaciones `serious`/`critical`.
- `tests/e2e/paridad-restaurantes-login.spec.ts` — levanta `npm run dev` de `atiende-restaurantes` (solo lectura, sin tocar esa carpeta) en un puerto libre, captura su login real a `tests/e2e/screenshots/restaurantes-login.png` y mata el proceso al terminar; si esa app externa no arranca, el test se marca `skipped` y el motivo queda en `docs/logs/h3-paridad-restaurantes.log`.

```bash
cd apps/web
npx playwright test                 # las tres suites, ambos proyectos
```

## hotel-staff-pwa (ADR-002)

`public/manifest.json` + `public/sw.js` implementan la PWA mínima real
descrita en ADR-002: instalable, cachea el shell de la app (no la API) para
tolerar wifi débil/intermitente en zonas del hotel. No implementa
sincronización de datos offline (eso es `REQ-REC-013`, fuera de este alcance).
