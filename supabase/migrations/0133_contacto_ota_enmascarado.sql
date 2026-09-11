-- ORIGEN: packages/db/migrations/0133_contacto_ota_enmascarado.sql sha256:2d530ec4e39aba1870651e2752c1c47fbea4c3b8c96cac0c4eaa904ef7e3a9c3
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-018: "El agente de reservas debe capturar el teléfono/email real del huésped
-- cuando la OTA lo enmascara, mediante un link de check-in enviado por la mensajería
-- propia de esa OTA con consentimiento explícito, sin contactar antes por un canal ajeno
-- a la plataforma de la OTA." (BP-027, H05-024, H09-010, BP-122).
--
-- Contexto real: Booking.com/Expedia/Airbnb enmascaran por defecto el teléfono/email del
-- huésped detrás de un relay propio de la OTA -- el hotel nunca ve el contacto real hasta
-- que el huésped lo comparte voluntariamente (típicamente al completar el check-in
-- online, `complete_checkin_public()`, migración 0054). Mandar un WhatsApp/SMS/email
-- directo a ese contacto enmascarado no llega al huésped real (es un relay de la OTA, no
-- su teléfono) y viola la política de la OTA de contactarlo solo a través de su propia
-- plataforma antes de que él mismo comparta su contacto real.
--
-- REQ-RES-022/REQ-REV-008 (H15-006) siguen prohibiendo construir conectividad OTA propia
-- (API directa a Booking/Expedia/Airbnb) durante esta fase -- esta migración NO agrega un
-- conector real de mensajería por OTA (eso requeriría certificación/credenciales de cada
-- OTA, fuera de alcance declarado, mismo criterio que `hotel_pms_outbound_config`/
-- `FakeOutboundTaskSyncAdapter`, migración 0129). Lo que sí agrega, sin ninguna
-- credencial: (a) el dato que permite GATEAR contacto directo mientras siga enmascarado
-- (`reservation.guest_contact_masked_by_ota`, ver `packages/domain-hotel/src/reservas/
-- contactoOtaEnmascarado.ts` + `packages/agent-core/src/tools/messagingTools.ts`), y (b)
-- el vocabulario para REGISTRAR que un mensaje salió por el canal propio de la OTA en vez
-- de WhatsApp (valor 'ota' de `conversation_channel`, ver `routes/checkinOnline.ts`) y
-- que un consentimiento fue específicamente sobre REVELAR el contacto real (valor
-- 'contacto_real_ota' de `consent_kind`, distinto del 'tratamiento_datos' genérico que
-- todo check-in online ya registraba desde la migración 0068).
--
-- Import HONESTO (mismo criterio que `atribucionCanal.ts`/REQ-RES-020): ningún escritor
-- de ESTE repo produce hoy un `reservation.channel` distinto de 'directo' en producción
-- (no existe conector OTA real), así que esta columna tampoco se marcará `true` de forma
-- automática en producción hasta que exista una integración OTA/PMS real que la
-- alimente -- queda lista para ese día, y operable HOY a mano por el staff (front desk)
-- para el caso ya real de registrar manualmente una reserva que llegó por una OTA con
-- contacto enmascarado (`PATCH .../reservas/:reservationId/contacto-ota`, ver
-- `routes/checkinOnline.ts`), sin depender de ese conector futuro.
alter table public.reservation
  add column guest_contact_masked_by_ota boolean not null default false;
comment on column public.reservation.guest_contact_masked_by_ota is
  'true mientras el telefono/email del huesped de esta reserva sea el relay enmascarado de la OTA de origen (reservation.channel != ''directo''), no su contacto real -- se limpia a false automaticamente cuando el huesped completa el check-in online con su contacto real (complete_checkin_public, migracion 0054, ver routes/checkinOnline.ts).';

-- 'ota': mensajeria enviada por el canal propio de la OTA de origen (Booking/Expedia/
-- Airbnb Messaging) -- deliberadamente generico y no un valor por OTA especifica, porque
-- este repo no construye un conector por OTA (ver nota arriba); la OTA concreta de cada
-- reserva ya vive en `reservation.channel`.
alter type public.conversation_channel add value 'ota';

-- Consentimiento explicito de REVELAR el contacto real -- distinto del consentimiento
-- general de tratamiento de datos que 'tratamiento_datos' ya cubre para TODO check-in
-- online (con o sin OTA de por medio). Se registra unicamente cuando la reserva
-- efectivamente tenia el contacto enmascarado por una OTA al momento de completar el
-- check-in (ver routes/checkinOnline.ts).
alter type public.consent_kind add value 'contacto_real_ota';
