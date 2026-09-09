-- Conector outbound PMS-enterprise (packages/mcp-servers/outbound `OutboundTaskSyncPort`,
-- ver docs/integraciones/conector-pms-enterprise.md) -- MISMO PATRON que
-- `hotel_messaging_config` (0044, WhatsApp) y `hotel_voice_agent_config` (0126, voz):
-- credencial POR HOTEL (nunca un secreto global compartido entre hoteles de la cadena),
-- porque cada hotel de cadena apunta a un endpoint/secreto distinto de SU PROPIO sistema
-- de gestion de tareas (HotSOS/Optii-style).
--
-- `task_types` (default los 3 tipos que REQ pide enganchar): permite que un hotel reciba
-- solo, por ejemplo, tickets de mantenimiento en su sistema enterprise y siga manejando
-- housekeeping/tickets de huesped solo en este backend -- sin eso, activar el conector
-- para un hotel forzaria las 3 entidades a la vez aunque su sistema real solo cubra una.
--
-- `enabled` (default false, BP-016 "ningun canal nuevo entra activo por default", mismo
-- criterio que `hotel_voice_agent_config`): un hotel debe activarlo explicitamente
-- despues de configurar `webhook_url`/`webhook_secret" -- mientras este en false,
-- `syncTaskToOutboundConnector()` (packages/agent-core) no intenta ningun envio, aunque
-- la fila ya exista (permite precargar la config antes de encenderla de verdad).
--
-- A diferencia de `hotel_messaging_config`/`hotel_voice_agent_config`, aqui NO se
-- restringe el SELECT a frontdesk: `webhook_url`/`webhook_secret` son credenciales de
-- integracion tecnica hacia el sistema enterprise del hotel (no algo que frontdesk
-- necesite para soporte de primer nivel a huespedes), asi que solo owner/gm pueden
-- verla o modificarla -- igual que cualquier otra credencial de proveedor externo.
create table public.hotel_pms_outbound_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  webhook_url text not null,
  webhook_secret text not null,
  task_types text[] not null default array['housekeeping_task', 'maintenance_ticket', 'guest_ticket'],
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hotel_pms_outbound_config enable row level security;

create policy "hotel_pms_outbound_config_manager_select" on public.hotel_pms_outbound_config for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_pms_outbound_config_manager_insert" on public.hotel_pms_outbound_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_pms_outbound_config_manager_update" on public.hotel_pms_outbound_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_pms_outbound_config_manager_delete" on public.hotel_pms_outbound_config for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_pms_outbound_config to authenticated;
