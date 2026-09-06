-- H1 · audit_log (ADR-005/GOB-026): append-only, hash encadenado al registro anterior
-- DEL MISMO TENANT (cadena por tenant, no global, para no acoplar el historial de un
-- hotel al de otro). Ni UPDATE ni DELETE estan permitidos, ni siquiera para el dueño de
-- la fila: se bloquean con un trigger ademas de no otorgar esos privilegios via GRANT
-- (0010), como defensa en profundidad.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid references public.hotel(id) on delete set null,
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_created_idx on public.audit_log (tenant_id, created_at);

create or replace function public.audit_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_created_at timestamptz;
  v_canonical text;
begin
  v_created_at := coalesce(new.created_at, now());

  select hash into v_prev_hash
  from public.audit_log
  where tenant_id = new.tenant_id
  order by created_at desc, id desc
  limit 1;

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.tenant_id::text
    || '|' || coalesce(new.hotel_id::text, '')
    || '|' || coalesce(new.actor_user_id::text, '')
    || '|' || new.action
    || '|' || new.entity_type
    || '|' || coalesce(new.entity_id::text, '')
    || '|' || new.payload::text
    || '|' || v_created_at::text;

  new.prev_hash := v_prev_hash;
  new.created_at := v_created_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  return new;
end;
$$;

create trigger audit_log_set_hash_trg
  before insert on public.audit_log
  for each row execute function public.audit_log_set_hash();

create or replace function public.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log_append_only: % no esta permitido sobre audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger audit_log_block_update_trg
  before update on public.audit_log
  for each row execute function public.audit_log_block_mutation();

create trigger audit_log_block_delete_trg
  before delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();

-- record_audit_log(): unica via recomendada para insertar (SECURITY DEFINER) para que
-- ningun rol de aplicacion necesite INSERT directo sobre la tabla (ver grants en 0010).
create or replace function public.record_audit_log(
  _tenant_id uuid,
  _hotel_id uuid,
  _action text,
  _entity_type text,
  _entity_id uuid,
  _payload jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.audit_log;
begin
  insert into public.audit_log (tenant_id, hotel_id, actor_user_id, action, entity_type, entity_id, payload)
  values (_tenant_id, _hotel_id, auth.uid(), _action, _entity_type, _entity_id, _payload)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_audit_log(uuid, uuid, text, text, uuid, jsonb) from public;
grant execute on function public.record_audit_log(uuid, uuid, text, text, uuid, jsonb) to atiende_app, authenticated;

alter table public.audit_log enable row level security;
create policy "audit_log_tenant_select" on public.audit_log for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- record_audit_log() (SECURITY DEFINER) o por el rol propietario de las migraciones.
