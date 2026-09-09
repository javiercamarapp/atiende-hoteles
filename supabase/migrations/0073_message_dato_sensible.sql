-- ORIGEN: packages/db/migrations/0073_message_dato_sensible.sql sha256:cff16f5c5da09c95ef6c0b1b918a5456a9e16151b483abcefcd2e5fa503199ed
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- L-tarjeta (auditoria-2 legal CRÍTICO, REQ-HUE-010/H09-027): un huésped confundido
-- puede escribir su número de tarjeta por WhatsApp; el webhook público lo insertaba
-- tal cual en `message.body`, en texto plano, visible a cualquier rol del hotel. La
-- detección/redacción vive en `packages/domain-hotel/src/paymentFreeTextGuard.ts`
-- (Luhn real, no solo "parece una racha de dígitos") -- esta columna es la bandera
-- que le permite al resto del sistema (panel de mensajería, futuros reportes de
-- cumplimiento) saber que un mensaje se redactó por contener un dato de pago, sin
-- tener que volver a correr la detección sobre el texto ya redactado.
alter table public.message add column contiene_dato_sensible boolean not null default false;
