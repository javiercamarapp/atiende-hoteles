# Corrección auditoría-2 — lote C: frontend, operabilidad, arquitectura

Corrector: Sonnet, worktree aislado. Alcance: `docs/auditoria-2/frontend.md`,
`docs/auditoria-2/operabilidad.md`, `docs/auditoria-2/arquitectura.md` (ALTOS/MEDIOS/BAJOS;
estos tres rubros no tuvieron críticos en la ronda 2). Un commit por hallazgo, prueba
primero cuando aplicó. No se tocó ningún archivo de los lotes A (`packages/db`
migraciones 0060-0069, `server.ts`, rutas de privacidad, `apps/web` privacidad/check-in)
ni B (`domain-hotel`, `agent-core`, rutas folios/agentes/aprobaciones/mensajeria/cfdi/
reservas/huespedes, jobs noShow/nightAudit, `Agentes.tsx`).

## Tabla hallazgo → estado

| # | Rubro | Severidad | Hallazgo | Estado | Commit(s) |
|---|---|---|---|---|---|
| 1 | frontend | ALTO | Recepción/A&B llaman endpoints inexistentes, error atribuido al PMS/POS | **arreglado** | `1c71ab3` |
| 2 | frontend | ALTO | "Estimado: $0.00 MXN" en mantenimiento se ve como medición real | **arreglado** | `1ddbe7b` |
| 3 | frontend | MEDIO | "Pendiente de credenciales del PMS/CRM" en Disponibilidad/Huéspedes (datos 100% internos) | **arreglado** | `3ae24b5` |
| 4 | frontend | MEDIO | Controles de folio/recepción por debajo de 44px | **arreglado** (+ BAJO relacionado: axe no cubría `/recepcion`) | `05f31a2` |
| 5 | frontend | MEDIO | Columnas de folio ocultas en 390px sin indicio de scroll | **arreglado** | `5f45bb2` |
| 6 | frontend | BAJO | axe-core no cubre `/recepcion` | **arreglado** (junto con #4) | `05f31a2` |
| 7 | frontend | BAJO | Sin formateador de moneda compartido | **arreglado** | `597dc13` (+ `6791b4d` ajuste de aserción e2e) |
| 8 | operabilidad | ALTO | `restore.sh` declara "conteo igual" sobre backup vacío | **arreglado** | `03e62d0` |
| 9 | operabilidad | ALTO | `.pgdata` de `npm run dev` fuera de `.gitignore` | **arreglado** (causa raíz compartida con #8) | `b9ff03e` |
| 10 | operabilidad | ALTO | Error de pool descartado sin log | **arreglado** | `3af50e1` |
| 11 | operabilidad | ALTO | Alerta de dinero sin destinatario | **arreglado** | `8506f53` |
| 12 | operabilidad | MEDIO | Alerta de dinero sin `reservation_id`/`folio_id`/`charge_id` | **arreglado** | `a84739e` |
| 13 | operabilidad | MEDIO | Métricas HTTP sin etiqueta de hotel | **arreglado** | `1b3624c` |
| 14 | operabilidad | BAJO | Máquina limpia no arranca solo con "el README" | **arreglado** | `1244c04` |
| 15 | arquitectura | ALTO | Docs dicen `--experimental-strip-types`, código usa `--experimental-transform-types` | **arreglado parcialmente** — 6 de los 9+ archivos citados (los que no pertenecen a `packages/agent-core`, territorio de otro lote); nuevo check estático `scripts/check-runtime-flags.ts` | `83a757e` |
| 16 | arquitectura | MEDIO | `hotel_tax_config` con 400 vs 404 según la ruta | **arreglado** (no era archivo de lote A/B) | `2777adc` |
| 17 | arquitectura | MEDIO | Numeración de migraciones sin guardarraíl automatizado | **arreglado parcialmente** — detecta colisión de números, no colisión semántica | `0616845` |
| 18 | arquitectura | BAJO | `packages/db/README.md` describe el estado de H1 (12 migraciones) | **arreglado** | `6680907` |
| 19 | arquitectura | BAJO | Componente huérfano `ListaTickets.tsx` | **arreglado** (eliminado) | `011c61f` |
| 20 | arquitectura | BAJO | Dos cosas distintas llamadas "pms" en el repo | **arreglado** (documentado, no renombrado — renombrar es un cambio mayor fuera de alcance de una corrección de auditoría) | `8e8389b` |

**Pendiente declarado, no falso positivo:** en el hallazgo #15, `packages/agent-core/README.md`
y `packages/agent-core/src/{postgresApproval,runner,provider}.ts` (4 de los 9+ archivos
citados por la auditoría) siguen documentando `--experimental-strip-types` como vigente.
`agent-core` es territorio explícito de otro lote de esta misma ronda de corrección; no se
tocó para no arriesgar un conflicto de edición. `scripts/check-runtime-flags.ts` cubre
deliberadamente solo los archivos que este lote sí corrigió (comentario explícito en el
propio script) — extenderlo a `agent-core` es el siguiente paso natural una vez ese lote
actualice sus comentarios.

## Descartados

Ninguno — los 20 hallazgos de ALTOS/MEDIOS/BAJOS de los tres rubros resultaron reales tras
verificación (lectura de código + reproducción donde aplicó: `pg_terminate_backend` real
para el pool, `node --experimental-strip-types` real para el flag, dump/restore real con
`evaluarVerificacion`). `docs/runbooks/migraciones.md:49` fue evaluado y descartado como
instancia del hallazgo #15 (el comando ahí SÍ usa el flag correcto para ese script
específico, verificado empíricamente) — no se cambió esa línea.

## Trabajo adicional dentro del mismo alcance

- Se removió el código muerto que quedó huérfano al arreglar A&B (`listarPedidosAB`/
  `PedidoAB` en `apps/web/src/lib/api.ts`, ver commit `1c71ab3`).
- Se agregó `apps/api/src/routes/recepcion.ts` (endpoint nuevo mínimo sobre
  `reservation_status_event`, tabla ya existente) para el hallazgo #1.
- Migración `0080_maintenance_ticket_estimated_cost_nullable.sql` (expand-only) para el
  hallazgo #2 — necesaria para poder distinguir "sin estimar" (null) de "estimado en
  cero" a nivel de esquema.
- Se ajustaron 3 aserciones e2e/integración existentes que asumían el comportamiento
  ANTERIOR a estos fixes intencionales (`tests/e2e/login-real-y-resumen.spec.ts` por el
  separador de miles; dos en `tests/integration/api/observabilidad.spec.ts` por la nueva
  etiqueta `hotel` y por el nuevo tipo de alerta de arranque).

## Compuertas finales

- `npm run lint`: 0 errores (1 warning preexistente ajeno a este lote, en
  `tests/e2e/paridad-restaurantes-login.spec.ts`) — `docs/logs/aud2-C-lint-20260906-1927.log`.
- `npm run typecheck`: 0 errores — `docs/logs/aud2-C-typecheck-20260906-1927.log`.
- `npm test` (unit+integration+adversarial): verde en corridas aisladas de cada suite
  (`npx vitest run tests/unit`, `tests/integration --pool=forks --poolOptions.forks.singleFork`,
  `tests/adversarial --pool=forks --poolOptions.forks.singleFork`) corridas repetidas
  veces durante el desarrollo de este lote, siempre 100% verde (incluidas las corridas
  que validan cada hallazgo de forma aislada, citadas en cada commit). La corrida de
  `npm test` CONSOLIDADA al final de la sesión chocó DOS veces seguidas con
  `FATAL: could not create shared memory segment: No space left on device`
  (`shmget` fallando), empeorando entre el primer intento (14 de 38 archivos de
  integración fallaron así) y el segundo (31 de 38) -- agotamiento de memoria
  compartida SysV del SISTEMA OPERATIVO de esta máquina COMPARTIDA (`kern.sysv.shmall`
  es un límite conservador de macOS, ~4MB total; `ipcs -m` mostraba 35+ segmentos
  acumulados creciendo entre un intento y el otro), consistente con otros
  workers/correctores de esta misma ronda corriendo sus propias suites de
  `embedded-postgres` en paralelo en la misma máquina. No es un defecto de este lote:
  cada archivo que "falló" lo hizo al intentar levantar SU PROPIO `embedded-postgres`
  (`Postgres init script failed`) ANTES de ejecutar ninguna aserción de negocio -- 0 de
  las fallas fueron una aserción real rota. `tests/unit` (sin BD real, PGlite) pasó
  completo (455/456, 1 skip preexistente) en ambos intentos. Ver
  `docs/logs/aud2-C-test-20260906-1930.log` para el detalle exacto de ambos intentos.
- `npm run build`: OK (api+web) — `docs/logs/aud2-C-build-20260906-1817.log` (corrida
  previa a la limpieza de logs de la sesión cortada por 429; sin cambios de código desde
  entonces que pudieran romper el build).
- `npm run test:e2e`: 40 passed, 3 skipped (proyecto desktop-only), 3 failed en la
  corrida documentada en `docs/logs/aud2-C-e2e-20260906-1817.log` — de esos 3:
  - 1 era consecuencia esperada del fix del hallazgo #7 (`$1850 MXN` → `$1,850 MXN`),
    corregido en el commit `6791b4d` y reverificado en verde de forma aislada
    (`npx playwright test login-real-y-resumen --project=desktop`).
  - 2 (`h6-housekeeping-mantenimiento-mensajeria.spec.ts`, desktop+mobile) son
    **preexistentes, no causados por este lote** — verificado reproduciéndolos con
    `git stash` (todos los cambios de este lote fuera) y el mismo fallo aparece idéntico:
    `getByText(/pendiente de aprobación|enviado/i)` resuelve a 2 elementos (violación de
    modo estricto de Playwright) en la página de mensajería/aprobaciones, un archivo que
    este lote no tocó (territorio de mensajería/aprobaciones es de otro lote de esta
    misma ronda). No se intentó arreglar aquí para no invadir ese alcance.

## Notas de coordinación con lotes A/B

- El hallazgo de arquitectura sobre `hotel_tax_config` (#16) terminó siendo resoluble
  dentro de este lote: ni `apps/api/src/routes/tarifas.ts` ni `apps/api/src/pms/taxConfig.ts`
  estaban en la lista de archivos de los lotes A o B.
- El hallazgo de arquitectura sobre el flag de runtime (#15) SÍ tocó archivos de
  `packages/agent-core` — esos quedaron pendientes explícitamente, ver arriba.
- Ningún archivo de `Agentes.tsx`, `packages/agent-core`, `packages/domain-hotel`, rutas
  de folios/reservas/huéspedes/mensajería/aprobaciones/cfdi/agentes, migraciones
  0060-0069, `server.ts` ni privacidad/check-in fue editado por este lote.
