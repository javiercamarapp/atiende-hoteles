-- auditoria-2/legal [ALTO, parte de "opt-in/opt-out de marketing" y del riesgo general
-- de retencion indefinida ya senalado para la boveda de identidad]: "retencion
-- configurable por hotel para conversation/message con purga programada". Antes de esta
-- migracion no existia ningun mecanismo para que un hotel definiera cuanto tiempo
-- conservar el historial de conversaciones/mensajes de WhatsApp, ni ninguna purga
-- programada equivalente a `purgeExpiredIdentityVault` (bóveda de identidad) para este
-- dato -- que tambien es personal (REQ-HUE-*) y tambien deberia tener un limite, no
-- conservarse para siempre por defecto.
--
-- `conversation_retention_days` NULL significa "usa el default de la plataforma"
-- (ver DEFAULT_CONVERSATION_RETENTION_DAYS en apps/api/src/jobs/purgeConversations.ts
-- -- el NUMERO exacto de dias es una decision de negocio/legal pendiente de confirmar
-- con el fundador, marcada `pendiente-decision` en
-- docs/auditoria-2/correccion-A-seguridad-legal.md; el codigo nunca inventa un plazo
-- legal sin marcarlo como tal, mismo criterio que docs/runbooks/incidentes.md).
alter table public.hotel_messaging_config
  add column conversation_retention_days integer check (conversation_retention_days is null or conversation_retention_days > 0);

comment on column public.hotel_messaging_config.conversation_retention_days is
  'Dias de retencion de conversation/message para este hotel antes de la purga programada. NULL = usa el default de la plataforma (pendiente-decision, ver purgeConversations.ts).';
