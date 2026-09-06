# Runbook — Despliegue

Estado actual (H8): **CI configurado (`.github/workflows/ci.yml`), sin despliegue
automático a ningún entorno todavía** — el usuario decide cuándo publicar el repo
(`gh` está autenticado en esta máquina, pero ningún commit de este hito hace `push`).
Este runbook documenta el pipeline de calidad que SÍ existe y el despliegue manual
que aplicaría hoy; el despliegue continuo (CD) queda como trabajo de un hito
posterior.

## 1. CI (`.github/workflows/ci.yml`)

Disparadores: `push`/`pull_request` sobre cualquier rama (ajustar si se quiere acotar
a `main` + PRs una vez el repo se publique).

Orden de jobs (falla rápido primero, mismo criterio que
`docs/referencia/06-backoffice-agentes-likida.md` §5.1):

1. **lint** — `npm run lint` (ESLint sobre todo el monorepo).
2. **typecheck** — `npm run typecheck` (tsc sobre raíz, `tests/e2e`, `apps/api`;
   `apps/web` se valida dentro de su propio `npm run build`).
3. **test** — `npm test` (unit + integración DB + adversarial, con
   `embedded-postgres` real en el runner `ubuntu-latest` — ver §2 abajo).
4. **build** — `npm run build` (compila `apps/api` con `tsc --noEmit`, hace
   `vite build` de `apps/web`).
5. **e2e** — Playwright con el Chrome del runner (`channel: 'chrome'`, se instala vía
   `npx playwright install --with-deps chromium` en el job; ver §3) contra el build
   real (`vite preview`), sube capturas de `tests/e2e/screenshots/**` y el reporte de
   Playwright como *artifact* aunque el job falle.
6. **npm-audit** — `npm audit --audit-level=high`, bloqueante en `high`/`critical` de
   dependencias de **runtime** únicamente (ver `docs/auditoria-1/dependencias.md` para
   las excepciones documentadas, si las hay, con CVE/paquete/alcance/decisión).

Cada job depende del anterior (`needs:`) — un fallo en `lint` no gasta minutos de CI
corriendo `test`/`e2e`.

**Escaneo de secretos (REQ-SEG-012)**: este workflow NO agrega un job dedicado
(`gitleaks`/`trufflehog`) todavía — declarado como pendiente, no simulado. Una vez el
repo se publique en GitHub, el escaneo de secretos nativo de GitHub (Secret Scanning,
automático en repos públicos y disponible como Advanced Security en privados) cubre
parte del requisito sin configuración adicional; un job propio con `gitleaks` (más
estricto, corre también sobre PRs de forks) queda como mejora de un hito posterior.

## 2. Por qué `embedded-postgres` SÍ funciona en `ubuntu-latest` (y qué falta si no)

`embedded-postgres` descarga un binario de Postgres real por plataforma
(`@embedded-postgres/linux-x64` en el runner de GitHub Actions, arquitectura x64) —
no depende de Docker ni de un servicio Postgres preinstalado del runner. El job de
`test` NO declara un `services: postgres:` de GitHub Actions a propósito: los tests de
integración/adversarial abren su propio `embedded-postgres` efímero por archivo de
prueba (`tests/support/pg-fixture.ts`/`api-fixture.ts`), igual que en esta máquina de
desarrollo — así el runner de CI se comporta exactamente igual que el entorno local
(ADR-003), sin una segunda fuente de verdad sobre cómo se levanta Postgres.

Si un runner de Linux no tuviera las librerías nativas que Postgres necesita
(`libicu`, `zlib`, etc. — normalmente sí las trae `ubuntu-latest` de fábrica), la
inicialización de `embedded-postgres` fallaría con un error de `initdb`/carga de
librería explícito en el log del job `test`, nunca en silencio.

## 3. Playwright en CI: Chrome del runner, no el navegador de Playwright

Esta máquina de desarrollo usa `channel: 'chrome'` (Chrome del sistema, verificado en
`docs/referencia/07-stack-viabilidad.md` Experimento 4/5) para no depender de que
Playwright descargue sus propios binarios. `ubuntu-latest` de GitHub Actions no trae
Google Chrome estable preinstalado bajo el canal `chrome` que Playwright espera, así
que el job de CI lo instala explícitamente ANTES de correr las pruebas (Playwright sí
sabe instalar el canal `chrome` real, no solo Chromium genérico):

```yaml
- run: npx playwright install --with-deps chrome
```

Con esto, `playwright.config.ts` (`channel: 'chrome'`, sin cambios entre entornos) usa
el MISMO canal en desarrollo y en CI — a diferencia de instalar solo `chromium`
genérico (que sí requeriría cambiar la config o depender de un fallback que Playwright
no hace automáticamente para un `channel` explícito).

El test de paridad viva contra `atiende-restaurantes`
(`tests/e2e/paridad-visual.spec.ts`, describe "paridad viva") depende de que el repo
hermano `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes` exista en
el filesystem — **no existirá en el runner de CI** (es un repo separado, no un
submódulo). Ese test específico usa `test.skip` cuando el servidor no arranca (mismo
patrón que `paridad-restaurantes-login.spec.ts`), así que en CI se reporta `skipped`
con el motivo documentado en `docs/logs/h8-paridad-restaurantes-vivo.log`, nunca
`failed` — el spec de comparación OBLIGATORIA (fixture estático vs. Atiende Hoteles)
sí corre siempre y sí puede fallar el pipeline.

## 4. Validar el YAML del workflow antes de commitear

```bash
npx --yes action-validator .github/workflows/ci.yml   # si está disponible sin instalar nada nuevo de forma permanente
# o, alternativa sin red:
npx --yes yaml-lint .github/workflows/ci.yml
```
Salida real de esta validación para este archivo: `docs/logs/h8-ci-yaml-lint.log`.

## 5. Simulación local de cada job (antes de commitear el workflow)

Los MISMOS comandos que corre cada job, ejecutados a mano en esta máquina, con salida
guardada:

```bash
npm run lint                        > docs/logs/h8-ci-lint.log 2>&1
npm run typecheck                   > docs/logs/h8-ci-typecheck.log 2>&1
npm test                            > docs/logs/h8-ci-test.log 2>&1
npm run build                       > docs/logs/h8-ci-build.log 2>&1
npm run test:e2e                    > docs/logs/h8-ci-e2e.log 2>&1
npm audit --audit-level=high        > docs/logs/h8-ci-npm-audit.log 2>&1
```

## 6. Despliegue manual (hoy — sin CD todavía)

**[Backend, apps/api]**: cualquier host Node ≥22 con acceso de red a la BD de
producción. Pasos:
1. `npm ci && npm run build --workspace=apps/api`.
2. Definir variables de entorno de producción (ver `apps/api/.env.example`) —
   `NODE_ENV=production` fuerza que `JWT_SECRET`/`CORS_ALLOWED_ORIGINS` sean
   explícitos (sin default silencioso, ver `apps/api/src/env.ts`).
3. Apuntar `DATABASE_URL`/credenciales al proyecto Supabase de producción (ADR-003) —
   `apps/api/src/db.ts::bootstrapDevEngine` es SOLO para desarrollo local
   (`embedded-postgres`); producción necesita un `db.ts` alterno o una variable que
   decida el motor (**pendiente**: no construido en H8, declarado aquí como trabajo
   futuro, no simulado).
4. `node apps/api/dist/server.js` (o el runtime que decida el hito de despliegue).

**[Frontend, apps/web]**: build estático (`npm run build --workspace=apps/web`,
produce `apps/web/dist/`) servible desde cualquier CDN/hosting estático con
`VITE_API_URL` apuntando al backend desplegado — definido en tiempo de BUILD (Vite
inlinea `import.meta.env.*`), así que un cambio de `VITE_API_URL` requiere rebuild,
no solo redeploy.

## 7. Rollback

Sin infraestructura de despliegue automatizada todavía, el rollback hoy es: revertir
el commit/tag desplegado y repetir §6. Antes de cualquier rollback que involucre un
cambio de esquema: confirmar que las migraciones nuevas fueron expand-only (§migraciones
runbook) — un rollback de código NUNCA debe ir acompañado de un rollback de esquema
manual (`DROP`/`ALTER` a mano) fuera del patrón de migraciones versionadas.
