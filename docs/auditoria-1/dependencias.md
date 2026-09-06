# Dependencias — H8 (REQ-QA-008)

**Estado el 2026-09-06 (después del arreglo de este hito): 0 vulnerabilidades en
`npm audit` a cualquier severidad** (`docs/logs/h8-ci-npm-audit.log`,
`npm audit --audit-level=high` sale en verde con código de salida 0).

## Hallazgo previo (auditoria-1/seguridad.md) y su resolución

`docs/auditoria-1/seguridad.md` (línea 26-29) registró, antes de este hito:

> Corrí `npm install --no-audit --no-fund` (ya estaba instalado), `npm audit` (1 alta
> en `postcss`, dependencia transitiva de build de `apps/web`/Tailwind — es una
> herramienta de build que procesa CSS del propio repo, no input de un atacante en
> runtime; se descarta como insumo sin camino de explotación real en este producto, no
> como veredicto)

| Campo | Detalle |
|---|---|
| Paquete | `postcss` |
| Versión afectada | `<=8.5.22` (declarada como devDependency directa de `apps/web` en `8.5.6`) |
| CVEs/advisories | GHSA-qx2v-qp2m-jg93 (XSS vía `</style>` sin escapar en el stringify de PostCSS), GHSA-6g55-p6wh-862q y su fix incompleto GHSA-fxqj-rqcc-2cmp (lectura arbitraria de archivo vía `sourceMappingURL` controlado por atacante), GHSA-r28c-9q8g-f849 (path traversal vía auto-carga de source map) |
| Severidad reportada | high |
| Alcance real en esta app | **Ninguno en runtime**: PostCSS solo corre en tiempo de BUILD (`vite build`/`tailwindcss`) sobre el CSS del propio repo (`packages/ui/src/index.css`, `apps/web/src/pages/login.css`) — nunca procesa CSS ni `sourceMappingURL` proporcionado por un usuario final o un tercero no confiable. Los CVEs listados asumen un atacante que controla el CSS de entrada de PostCSS, escenario que no existe en este pipeline. |
| Decisión tomada | **Resuelto** (no solo documentado): se actualizó la versión fijada de `postcss` en `apps/web/package.json` de `8.5.6` a `8.5.28` (la misma versión ya deduplicada para el resto del árbol vía `tailwindcss`/`vite`/`vitest` — confirmado con `npm ls postcss` antes y después). `npm audit --audit-level=high` pasó de 1 alta a 0 vulnerabilidades sin romper ninguna compuerta (`lint`/`typecheck`/`test`/`build`/`test:e2e` verdes después del cambio, ver `docs/logs/h8-ci-*.log`). |

## Excepciones documentadas sin resolver

**Ninguna.** No quedó ningún hallazgo de `npm audit --audit-level=high` sin resolver
al cierre de H8 — no hay excepciones de high/critical que registrar aquí.

## Criterio de bloqueo aplicado en CI (ADR-009)

`.github/workflows/ci.yml` (`job: npm-audit`) corre `npm audit --audit-level=high`
como puerta bloqueante, sin distinguir manualmente runtime vs. devDependencies en el
comando (npm no separa audit por ese eje) — el criterio real de "no bloquear por
vulnerabilidades de tooling sin camino de explotación" se aplica MANUALMENTE, como en
este documento: cualquier hallazgo `high`/`critical` nuevo se evalúa caso por caso
(¿el paquete corre en el servidor de producción/el navegador del usuario final, o
solo durante `build`/`test` en la máquina del desarrollador/CI?) y, si de verdad no
tiene alcance real, se documenta aquí con CVE/paquete/alcance/decisión — nunca se
silencia con `--production` o excluyendo el job.

## Cómo reproducir esta verificación

```bash
npm audit --audit-level=high   # debe salir en 0 (código de salida 0)
npm audit --json > /tmp/audit.json && node -e \
  "console.log(JSON.parse(require('fs').readFileSync('/tmp/audit.json','utf8')).metadata.vulnerabilities)"
# esperado: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
```
