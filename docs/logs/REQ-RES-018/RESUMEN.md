---
type: log-cierre
status: hecho
created: 2026-09-10
updated: 2026-09-10
tags: [REQ-RES-018, res, ota, contacto-enmascarado, checkin]
---

# REQ-RES-018 — Cierre 2026-09-10

Criterio de aceptación literal (`docs/ACEPTACION.md`): "Con teléfono/email
enmascarado por OTA, el link de check-in se envía por la mensajería propia de
esa OTA con consentimiento explícito registrado; verificado que ningún
contacto sale por un canal ajeno a la OTA antes del consentimiento."

## Comandos y resultados reales

- `npx vitest run tests/unit/domain-hotel/contacto-ota-enmascarado.spec.ts` → 5/5.
- `npx vitest run tests/integration/ota/contacto-enmascarado.spec.ts` → 6/6
  (embedded-postgres real). Ver `integracion-20260910-233244.log`.
- `npm run test:unit` (suite completa) → 115 archivos, 1328 tests, 1 skip, 0
  fallos. Ver `unit-completo-20260910-233354.log`.
- Batch dirigido de regresión (34 archivos integración/adversarial que tocan
  reservas/mensajería/consentimiento/check-in) → 33/35 en verde en la primera
  corrida bajo carga de máquina compartida; los 2 restantes
  (`tarifas-y-aislamiento-reservas.spec.ts`, `recepcion.spec.ts`) fallaron por
  timeout de hook de 30s (arranque de embedded-postgres bajo contención de
  CPU con otras sesiones concurrentes en la misma Mac, nada relacionado con
  este cambio) y pasaron limpio 7/7 al re-correrlos aislados dos veces
  seguidas. Ver `regresion-dirigida-20260910-233554.log` +
  `rerun-aislado-flakiness-descartada-20260910-234107.log`.
- `npm run typecheck`, `npm run lint`, `npm run check:migraciones` → limpios.
- `node --experimental-strip-types scripts/export-supabase-migrations.ts` →
  espejo `supabase/migrations/0130_contacto_ota_enmascarado.sql` generado y
  verificado con `--check`.

## Qué se construyó

- Migración `packages/db/migrations/0130_contacto_ota_enmascarado.sql`:
  `reservation.guest_contact_masked_by_ota`, valor `'ota'` en
  `conversation_channel`, valor `'contacto_real_ota'` en `consent_kind`.
- Dominio puro: `packages/domain-hotel/src/reservas/contactoOtaEnmascarado.ts`
  (`esContactoEnmascaradoPorOta`/`debeBloquearContactoPorCanalAjenoALaOta`).
- API (`apps/api/src/routes/checkinOnline.ts`): `PATCH
  .../reservas/:id/contacto-ota` (staff marca/desmarca) y `POST
  .../reservas/:id/checkin-link-ota` (emite el enlace y lo registra en
  `conversation`/`message` con `channel='ota'`, `simulated=true` — nunca
  WhatsApp). `POST /checkin-publico/:token` ahora también limpia el flag y
  registra `consent_kind='contacto_real_ota'` cuando aplica.
- Gate gemelo en `packages/agent-core/src/tools/messagingTools.ts`
  (`isGuestContactMaskedByOta`/`OtaContactoEnmascaradoError`, sin depender de
  `domain-hotel` — límite arquitectónico del paquete respetado) + wiring en
  `apps/api/src/routes/mensajeria.ts` (mismo patrón que
  `isMarketingSendBlocked`, rechazo temprano + defensa en profundidad dentro
  de `tool.run()`).

## Honestidad declarada

Sin conector real de ninguna OTA (Booking/Expedia/Airbnb) — REQ-RES-022/
REQ-REV-008/H15-006 siguen prohibiendo esa conectividad en esta fase. El
"envío por la mensajería propia de la OTA" se registra con `simulated=true`
(mismo mecanismo honesto que `FakeWhatsappAdapter`, ADR-007), listo para un
conector real certificado el día que exista. Mientras tanto, el staff marca a
mano el canal/masking de una reserva que llegó por una OTA (caso real de hoy,
sin conector automático) vía `PATCH .../contacto-ota`.
