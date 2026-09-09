-- ORIGEN: packages/db/migrations/0099_marketing_optin_gate.sql sha256:abe3ec1016a396ffaecbd591f97f95105c38411073d97de7b005ca97aceaa363
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HUE-021/REQ-SEG-007 (P0/GOB): "diferenciar mensajes transaccionales (utility, sin
-- opt-in de marketing requerido) de mensajes de marketing (requieren opt-in explícito,
-- registrado con fecha/canal/texto) antes de cualquier envío promocional."
--
-- La infraestructura de opt-in YA EXISTE desde 0068_consentimiento_y_arco.sql (tabla
-- `consent`, `consent_kind` ya incluye 'marketing', `channel` ya incluye 'whatsapp',
-- `record_consent()` ya persiste fecha=created_at/canal=channel/texto=aviso_version) --
-- ese mismo archivo deja escrito explícitamente que el "bloqueo" en el envío de
-- plantillas de WhatsApp (`packages/agent-core/src/tools/messagingTools.ts`) "pertenece
-- a ese otro lote" y queda `pendiente-coordinacion`. Esta migración es exactamente esa
-- coordinación: solo agrega lo que falta para que la tool de envío pueda CONSULTAR qué
-- plantillas son de marketing (nunca inventa una tabla de consentimiento nueva).
--
-- `marketing_templates` es una lista de permitidos EXPLÍCITA (igual patrón que
-- `transactional_templates`, migración 0044) -- default vacía: ninguna plantilla exige
-- opt-in hasta que el hotel la marque como de marketing. Deny-by-default en la otra
-- dirección (la CONSULTA de opt-in) vive en el código de la tool, no aquí: sin huésped
-- identificado por teléfono, o sin fila `consent` con `granted = true`, se trata como
-- "sin opt-in".
alter table public.hotel_messaging_config
  add column marketing_templates text[] not null default '{}';

comment on column public.hotel_messaging_config.marketing_templates is
  'Plantillas de WhatsApp clasificadas como marketing/promocionales para este hotel (REQ-HUE-021/REQ-SEG-007): enviarlas exige una fila `consent` previa (channel=whatsapp, consent_kind=marketing, granted=true) para el huésped destinatario, o el envío se bloquea (0 mensajes creados). Cualquier plantilla fuera de esta lista se trata como transaccional/utility y nunca requiere opt-in.';

-- Soporta la consulta de opt-in en el camino caliente de cada intento de envío de
-- marketing (join guest.phone -> consent.guest_id, filtrado por hotel/canal/tipo/
-- otorgado) -- mismo criterio de "índice para el patrón de consulta real" que el resto
-- de las migraciones de este repo, no un índice genérico.
create index consent_marketing_optin_idx on public.consent (hotel_id, guest_id, channel, consent_kind)
  where granted = true;
