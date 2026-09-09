-- H17 (fix/voz-elevenlabs) · Telefonia/voz real para hoteles con ElevenLabs Conversational
-- AI, MISMO PATRON que el repo hermano atiende-restaurantes (ElevenLabs es quien maneja
-- telefonia + modelo de voz de punta a punta via su propia plataforma de agentes; nunca
-- Twilio+STT/TTS por separado). Ver docs/agente-voz/ de este repo para el diseño completo.
--
-- A diferencia de `hotel_messaging_config` (WhatsApp, migracion 0044), aqui NO se verifica
-- el secreto contra una firma HMAC del cuerpo -- ElevenLabs Server Tools autentican con un
-- header estatico configurado en el propio tool (ver client-tools.md de la skill "agents":
-- `request_headers` puede referenciar un secreto de workspace, `{{VOICE_TOOL_SECRET}}`).
-- `tool_webhook_secret` es ESE valor, generado por hotel (nunca un secreto global
-- compartido entre hoteles, a diferencia del `x-atiende-tool-secret` unico de
-- atiende-restaurantes) -- el aislamiento por tenant es el eje de seguridad central de
-- este repo (REQ-TEN-*), asi que un secreto por hotel es la adaptacion correcta del
-- patron, no una copia literal.
--
-- `elevenlabs_agent_id` es solo bookkeeping/auditoria (que agente de ElevenLabs
-- corresponde a este hotel) -- la resolucion real de tenant en el webhook viene del
-- `:hotelId` de la URL (mismo criterio que `hotel_messaging_config`/
-- `routes/mensajeria.ts`), nunca de un campo que ElevenLabs mande en el cuerpo.
--
-- `enabled` (default false, BP-016 "ningun canal nuevo entra activo por default"): un
-- hotel debe activarlo explicitamente despues de completar los pasos manuales del
-- runbook (ver docs/agente-voz/runbook-pasos-manuales.md) -- mientras este en false, el
-- webhook rechaza cualquier llamada de tool con 403, incluso con el secreto correcto.
create table public.hotel_voice_agent_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  elevenlabs_agent_id text,
  tool_webhook_secret text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bookkeeping, no resolucion de tenant (ver comentario de archivo): igual asi, dos
-- hoteles nunca deberian compartir por accidente el mismo agent_id de ElevenLabs.
create unique index hotel_voice_agent_config_agent_id_idx
  on public.hotel_voice_agent_config (elevenlabs_agent_id)
  where elevenlabs_agent_id is not null;

alter table public.hotel_voice_agent_config enable row level security;

-- Mismos roles/criterio que `hotel_messaging_config` (migracion 0044): frontdesk necesita
-- ver el secreto para poder soporte de primer nivel ("ese numero no contesta, revisa la
-- config"), pero solo owner/gm pueden crear/rotar/activar.
create policy "hotel_voice_agent_config_manager_select" on public.hotel_voice_agent_config for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));
create policy "hotel_voice_agent_config_manager_insert" on public.hotel_voice_agent_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_voice_agent_config_manager_update" on public.hotel_voice_agent_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.hotel_voice_agent_config to authenticated;
