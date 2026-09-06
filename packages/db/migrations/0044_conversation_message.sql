-- H6b · REQ-HUE-*/REQ-HK-002/013/021: bandeja de mensajeria por huesped (WhatsApp/voz/web)
-- sobre el `MessagingPort` de `packages/mcp-servers/whatsapp` (H9), sin llamar nunca a
-- Meta de verdad en este hito -- `hotel_messaging_config.webhook_secret` es el secreto del
-- ADAPTADOR FAKE por hotel (HMAC del webhook simulado, ver README de ese paquete);
-- `message.simulated=true` deja explicito en el propio dato que la entrega es simulada
-- mientras no haya credenciales reales de Meta (ver README de este hito, "PENDIENTE DE
-- CREDENCIALES"). `message.body` NO se redacta al guardarse (el staff necesita leer el
-- mensaje real del huesped) -- la redaccion de PII aplica a TRAZAS/logs del agente
-- (agent-core `redact()`), no al dato operativo protegido por RLS.

create table public.hotel_messaging_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  provider text not null default 'meta-whatsapp',
  webhook_secret text not null,
  tier text not null default 'tier_1k',
  -- Plantillas que la tool "enviar mensaje WhatsApp" puede mandar SIN pasar por
  -- ApprovalQueue (transaccionales: confirmacion de reserva, recordatorio de checkin...).
  -- Cualquier otra plantilla/mensaje libre exige aprobacion humana (needsApproval=true,
  -- effect="external", ver agent-core tools de este hito).
  transactional_templates text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.conversation_channel as enum ('whatsapp', 'voz', 'web');
create type public.conversation_status as enum ('abierta', 'cerrada');
create type public.message_direction as enum ('entrante', 'saliente');
create type public.message_delivery_status as enum ('enviado', 'entregado', 'leido', 'fallido');

create table public.conversation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid references public.guest(id) on delete set null,
  channel public.conversation_channel not null default 'whatsapp',
  guest_phone text,
  status public.conversation_status not null default 'abierta',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversation_tenant_hotel_idx on public.conversation (tenant_id, hotel_id);
create unique index conversation_hotel_guest_channel_idx
  on public.conversation (hotel_id, channel, guest_phone)
  where guest_phone is not null;

create table public.message (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  conversation_id uuid not null references public.conversation(id) on delete cascade,
  direction public.message_direction not null,
  channel public.conversation_channel not null,
  template_name text,
  body text not null,
  requires_approval boolean not null default false,
  approval_id uuid references public.agent_approval(id) on delete set null,
  client_message_id text,
  external_message_id text,
  delivery_status public.message_delivery_status,
  -- true mientras el adaptador de WhatsApp sea `FakeWhatsappAdapter` (sin credenciales de
  -- Meta) -- ver README del hito. El frontend usa esta columna para mostrar el estado de
  -- entrega como "simulado" en vez de aparentar una entrega real que nunca ocurrio.
  simulated boolean not null default true,
  created_at timestamptz not null default now()
);
create index message_conversation_idx on public.message (conversation_id, created_at);
create index message_tenant_hotel_idx on public.message (tenant_id, hotel_id);
-- Idempotencia de envio (clientMessageId, contrato MessagingPort) y de recepcion de
-- webhook (externalMessageId) por hotel.
create unique index message_hotel_client_message_idx
  on public.message (hotel_id, client_message_id)
  where client_message_id is not null;
create unique index message_hotel_external_message_idx
  on public.message (hotel_id, external_message_id)
  where external_message_id is not null;

-- Mantiene `conversation.last_message_at/status` en sincronia sin depender de que la capa
-- de aplicacion recuerde actualizarlo en cada INSERT de message (mismo espiritu SECURITY
-- DEFINER que `reservation_log_status_event`, 0006).
create or replace function public.conversation_touch_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversation
  set last_message_at = new.created_at, updated_at = now(), status = 'abierta'
  where id = new.conversation_id;
  return new;
end;
$$;
create trigger conversation_touch_on_message_trg
  after insert on public.message
  for each row execute function public.conversation_touch_on_message();

alter table public.hotel_messaging_config enable row level security;
alter table public.conversation enable row level security;
alter table public.message enable row level security;

create policy "hotel_messaging_config_manager_select" on public.hotel_messaging_config for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));
create policy "hotel_messaging_config_manager_insert" on public.hotel_messaging_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_messaging_config_manager_update" on public.hotel_messaging_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- SELECT amplio (cualquier staff del hotel) -- la bandeja de mensajeria es transversal
-- (recepcion, gerente, y cualquier agente que necesite dar seguimiento a un huesped).
create policy "conversation_staff_select" on public.conversation for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "conversation_frontdesk_insert" on public.conversation for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "conversation_frontdesk_update" on public.conversation for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

create policy "message_staff_select" on public.message for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "message_frontdesk_insert" on public.message for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

grant select, insert, update on public.hotel_messaging_config to authenticated;
grant select, insert, update on public.conversation to authenticated;
grant select, insert on public.message to authenticated;
