---
type: evidencia
status: hecho
created: 2026-09-10
updated: 2026-09-10
tags: [REQ-OBS-008, atribucion-canal, room-nights, kpi-agentico]
---

# REQ-OBS-008 — % de room-nights directas por origen agéntico

## Contrato exacto

- `docs/REQUISITOS.md`: "El sistema debe reportar el % de room-nights directas
  generadas por origen agéntico/canal como métrica de producto periódica." (BP-169,
  H06-016).
- `docs/ACEPTACION.md`: "% de room-nights directas por origen agéntico/canal reportado
  periódicamente como métrica de producto (verificado con dataset sintético y
  reproducción exacta del porcentaje)." Prueba prescrita:
  `tests/integration/obs/room-nights-directas.spec.ts`.
- Fuente original: H06-016 = "El sistema debe instrumentar y reportar el % de
  room-nights generadas directamente por agentes de IA como métrica de producto";
  BP-169 = "Métrica norte comercial: room-nights directas generadas por el agente
  (KPI de la tesis agéntica)".

## Hallazgo: `atribucionCanalRoutes` NO cumplía este criterio

`apps/api/src/routes/atribucionCanal.ts` / `packages/domain-hotel/src/reservas/atribucionCanal.ts`
(REQ-RES-020) miden un eje distinto: room-nights por **canal de distribución**
(`reservation.channel`: directo / OTA / agente de IA EXTERNO que reserva a nombre del
huésped, como un channel manager). Su `directRoomNightsPct` es "% de room-nights que
NO pasaron por un intermediario externo" — no dice nada sobre si el propio agente de
IA del hotel fue quien generó la reserva.

H06-016/BP-169 piden el KPI de la TESIS del producto: qué % de room-nights las generó
directamente el agente conversacional propio del hotel. Esa dimensión (actor interno
que creó la reserva: staff vs. agente) no existía en ningún lado del esquema.

## Qué se construyó

- `packages/db/migrations/0130_reservation_origin_actor.sql`: columna
  `reservation.origin_actor` ('manual' | 'agente_ia', default 'manual', CHECK a nivel
  de esquema). Espejo en `supabase/migrations/0130_reservation_origin_actor.sql` vía
  `node --experimental-strip-types scripts/export-supabase-migrations.ts`.
- `packages/domain-hotel/src/reservas/atribucionOrigenAgentico.ts`: módulo puro,
  `buildAgenticOriginReport()` — agrega room-nights por `origin_actor` y calcula
  `agenticRoomNightsPct` (0 si no hay datos, nunca `NaN`).
- `apps/api/src/domain/atribucionOrigenAgentico.ts`: agregación SQL real
  (`buildAgenticOriginReportForHotel`), mismo filtro de estados "reserva real" que
  `atribucionCanal.ts` (excluye cotizada/cancelada/no_show).
- `apps/api/src/routes/roomNightsDirectas.ts`: `GET
  /hoteles/:hotelId/reportes/room-nights-directas?desde=...&hasta=...`. Sin
  restricción de rol adicional a membresía del hotel (es KPI de producto/uso, no
  cifra de comisión — mismo criterio que `routes/roi.ts`).
- Registrado en `apps/api/src/app.ts`.

## Honestidad declarada

Ningún escritor de este repo produce hoy `origin_actor = 'agente_ia'`: el único
endpoint de creación de reservas (`POST /hoteles/:hotelId/reservas`) exige sesión de
staff autenticado vía `requireHotelMembership`. Ningún flujo conversacional
(WhatsApp/voz) crea reservas de forma autónoma en este repo todavía — esa capacidad es
un REQ-AGT/REQ-RES futuro, fuera de alcance de este cierre. El reporte queda construido
y verificado (dataset sintético) para el día en que ese flujo exista y escriba
'agente_ia', sin necesitar otra migración ni cambio de contrato ese día.

## Evidencia (comandos + resultado real)

```
$ npm run check:migraciones
check-migraciones: OK (95 migración(es) verificadas contra el manifiesto base, 0 DROP/ALTER destructivo sin aprobar).

$ npm run typecheck
(sin errores)

$ npx vitest run tests/unit/domain-hotel/room-nights-directas.spec.ts
 ✓ tests/unit/domain-hotel/room-nights-directas.spec.ts (7 tests)
 Test Files  1 passed (1)
      Tests  7 passed (7)

$ npx vitest run tests/integration/obs/room-nights-directas.spec.ts
 ✓ tests/integration/obs/room-nights-directas.spec.ts (4 tests)
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Regresión verificada: `npm run test:unit` (115 archivos, 1330 tests, 1 skip
preexistente) y `npm run test:integration` (72 archivos, 439 tests) en verde completo
tras la migración 0130, incluyendo `tests/integration/reservas/atribucion-canal.spec.ts`
(7/7, sin romper REQ-RES-020).

Logs completos: `docs/logs/REQ-OBS-008/*.log` (mismo directorio, timestamp
20260910-224500).
