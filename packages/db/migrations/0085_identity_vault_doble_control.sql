-- REQ-SEG-014 (cierre del pendiente declarado en 0051/docs/REQUISITOS.md): "doble
-- control" pleno para la bóveda de identidad -- una lectura sensible (revelar el
-- número de documento completo) debe requerir la aprobación de una SEGUNDA persona
-- antes de exponerse, no solo el rol owner/gm de quien la pide.
--
-- Hasta esta migración, `read_identity_vault_document()` (0051) exigía rol owner/gm +
-- motivo + bitácora, pero UNA sola persona con ese rol podía revelar el documento sin
-- que nadie más lo supiera de antemano ni lo autorizara -- exactamente el hueco que la
-- cabecera de 0051 y `docs/REQUISITOS.md` (REQ-SEG-014) documentan como NO
-- implementado.
--
-- Flujo nuevo (tres funciones SECURITY DEFINER, mismo patrón que el resto de la
-- bóveda -- ningún acceso directo a la tabla nueva para escribir, ver policies abajo):
--   1. `request_identity_vault_access(identity_ref_id, reason)` -- un owner/gm
--      solicita acceso; la solicitud queda `pendiente`.
--   2. `decide_identity_vault_access(request_id, decision)` -- un owner/gm DISTINTO de
--      quien solicitó aprueba o rechaza; auto-aprobación explícitamente rechazada
--      (`autoaprobacion_no_permitida`) -- este es el núcleo del doble control.
--   3. `reveal_identity_vault_document(request_id)` -- SOLO quien solicitó puede
--      consumir una solicitud ya `aprobada`; de un solo uso (`consumed_at`), dentro de
--      la ventana de vigencia de la solicitud (30 minutos, igual orden de magnitud que
--      `agent_approval`, 0042).
--
-- Cada paso dejá su propio evento en `audit_log` (`identity_vault.access_requested`/
-- `access_approved`/`access_rejected`/`decrypted`) -- la bitácora ya no solo registra
-- QUIÉN reveló, sino también QUIÉN lo pidió y QUIÉN lo autorizó.
--
-- Límite conocido (mismo problema que 0075 documenta para la doble confirmación de
-- dinero): un hotel con un solo actor real en rol owner/gm no tiene una segunda
-- persona que pueda aprobar -- sus solicitudes de acceso a la bóveda quedarán sin
-- poder completarse (expiran a los 30 minutos) hasta que exista un segundo owner/gm.
-- A diferencia de GOB-026/dinero, REQ-SEG-014 no declara explícitamente un mecanismo
-- de delegado para este caso, así que no se agrega aquí -- documentado para que no se
-- lea como un descuido.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tabla nueva + funciones
-- reemplazadas vía `create or replace function`/`drop function` (mismo patrón que
-- 0065/0067 sobre esta misma bóveda).

create type public.identity_vault_access_status as enum ('pendiente', 'aprobada', 'rechazada', 'expirada', 'consumida');

create table public.identity_vault_access_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  identity_ref_id uuid not null references public.identity_ref(id) on delete cascade,
  requested_by uuid not null references public.staff_user(id) on delete restrict,
  reason text not null,
  status public.identity_vault_access_status not null default 'pendiente',
  approved_by uuid references public.staff_user(id) on delete restrict,
  decided_at timestamptz,
  consumed_at timestamptz,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El aprobador nunca puede ser quien solicitó -- esto es además una invariante de
  -- fila (defensa en profundidad sobre la validación en `decide_identity_vault_access`).
  constraint identity_vault_access_request_approver_distinto check (approved_by is null or approved_by <> requested_by)
);
create index identity_vault_access_request_hotel_status_idx on public.identity_vault_access_request (hotel_id, status);
create index identity_vault_access_request_ref_idx on public.identity_vault_access_request (identity_ref_id);

alter table public.identity_vault_access_request enable row level security;
-- SELECT: transparencia dentro del hotel para owner/gm (misma bandeja que
-- `agent_approval`, 0042) -- ver quién solicitó, quién decidió y en qué estado está.
-- housekeeping/maintenance/fnb/frontdesk/reservations/accountant nunca necesitan ver
-- esto (mismo criterio de acceso que `identity_ref`, más estricto: aquí ni siquiera
-- frontdesk/reservations, que sí pueden REGISTRAR identidad, pueden ver solicitudes de
-- revelado -- revelar el documento completo siempre fue exclusivo de owner/gm).
create policy "identity_vault_access_request_manager_select" on public.identity_vault_access_request for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
-- Sin ninguna policy de insert/update/delete para `authenticated`: toda escritura pasa
-- por las funciones SECURITY DEFINER de abajo (mismo criterio que `identity_vault`).
grant select on public.identity_vault_access_request to authenticated;

-- request_identity_vault_access(): paso 1 -- un owner/gm solicita acceso a un
-- `identity_ref` concreto, documentando el motivo. Nunca ve ni toca la bóveda misma.
create or replace function public.request_identity_vault_access(
  _identity_ref_id uuid,
  _reason text
)
returns public.identity_vault_access_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_ref public.identity_ref;
  v_row public.identity_vault_access_request;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: solicitar acceso a la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'motivo_requerido: toda solicitud de acceso a la bóveda de identidad debe documentar un motivo (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = _identity_ref_id;
  if not found then
    raise exception 'identity_ref_no_encontrado: %', _identity_ref_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_ref.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_ref.hotel_id
      using errcode = '42501';
  end if;

  insert into public.identity_vault_access_request (tenant_id, hotel_id, identity_ref_id, requested_by, reason)
  values (v_ref.tenant_id, v_ref.hotel_id, _identity_ref_id, v_actor, _reason)
  returning * into v_row;

  perform public.record_audit_log(v_ref.tenant_id, v_ref.hotel_id, 'identity_vault.access_requested', 'identity_ref', v_ref.id,
    jsonb_build_object('requestId', v_row.id, 'reason', _reason));

  return v_row;
end;
$$;

revoke all on function public.request_identity_vault_access(uuid, text) from public;
grant execute on function public.request_identity_vault_access(uuid, text) to atiende_app, authenticated;

-- decide_identity_vault_access(): paso 2 -- núcleo del doble control. Un owner/gm
-- DISTINTO del solicitante aprueba o rechaza. Nunca ve ni toca la bóveda misma
-- (solo cambia el estado de la solicitud).
create or replace function public.decide_identity_vault_access(
  _request_id uuid,
  _decision text
)
returns public.identity_vault_access_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.identity_vault_access_request;
  v_new_status public.identity_vault_access_status;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: decidir una solicitud de la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  if _decision not in ('aprobar', 'rechazar') then
    raise exception 'decision_invalida: "%" no es aprobar/rechazar', _decision using errcode = 'P0001';
  end if;

  select * into v_row from public.identity_vault_access_request where id = _request_id;
  if not found then
    raise exception 'solicitud_no_encontrada: %', _request_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_row.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_row.hotel_id
      using errcode = '42501';
  end if;

  if v_row.status <> 'pendiente' then
    raise exception 'solicitud_no_pendiente: la solicitud % ya está en estado % (REQ-SEG-014)', _request_id, v_row.status
      using errcode = 'P0001';
  end if;

  if now() > v_row.expires_at then
    update public.identity_vault_access_request set status = 'expirada', updated_at = now() where id = _request_id;
    raise exception 'solicitud_expirada: la solicitud % venció el % (REQ-SEG-014)', _request_id, v_row.expires_at
      using errcode = 'P0001';
  end if;

  -- Doble control: el aprobador debe ser una persona DISTINTA de quien solicitó --
  -- nunca la misma persona auto-aprobándose (aunque tenga el rol correcto).
  if v_actor = v_row.requested_by then
    raise exception 'autoaprobacion_no_permitida: quien solicita el acceso no puede aprobar su propia solicitud (REQ-SEG-014)'
      using errcode = '42501';
  end if;

  v_new_status := case _decision
    when 'aprobar' then 'aprobada'::public.identity_vault_access_status
    else 'rechazada'::public.identity_vault_access_status
  end;

  update public.identity_vault_access_request
  set status = v_new_status, approved_by = v_actor, decided_at = now(), updated_at = now()
  where id = _request_id
  returning * into v_row;

  perform public.record_audit_log(v_row.tenant_id, v_row.hotel_id,
    case _decision when 'aprobar' then 'identity_vault.access_approved' else 'identity_vault.access_rejected' end,
    'identity_ref', v_row.identity_ref_id,
    jsonb_build_object('requestId', v_row.id, 'requestedBy', v_row.requested_by));

  return v_row;
end;
$$;

revoke all on function public.decide_identity_vault_access(uuid, text) from public;
grant execute on function public.decide_identity_vault_access(uuid, text) to atiende_app, authenticated;

-- reveal_identity_vault_document(): paso 3 -- reemplaza a `read_identity_vault_document`
-- (0051) como único punto de lectura de los bytes cifrados. Ahora exige una solicitud
-- ya `aprobada` por una segunda persona, consumida exactamente una vez, y solo por
-- quien la solicitó originalmente.
create or replace function public.reveal_identity_vault_document(
  _request_id uuid
)
returns table (document_number_ciphertext bytea, document_number_iv bytea, document_number_auth_tag bytea)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.identity_vault_access_request;
  v_ref public.identity_ref;
  v_vault public.identity_vault;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: exponer un documento de la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_row from public.identity_vault_access_request where id = _request_id;
  if not found then
    raise exception 'solicitud_no_encontrada: %', _request_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_row.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_row.hotel_id
      using errcode = '42501';
  end if;

  -- Solo quien solicitó el acceso puede consumir la aprobación -- el aprobador (la
  -- segunda persona) autoriza, pero no adquiere por eso el derecho a leer el documento.
  if v_actor <> v_row.requested_by then
    raise exception 'actor_no_autorizado: solo quien solicitó el acceso puede exponer el documento de la solicitud % (REQ-SEG-014)', _request_id
      using errcode = '42501';
  end if;

  if v_row.status = 'consumida' then
    raise exception 'solicitud_ya_consumida: la solicitud % ya se usó para exponer el documento -- cada aprobación autoriza una sola lectura (REQ-SEG-014)', _request_id
      using errcode = 'P0001';
  end if;

  if v_row.status <> 'aprobada' then
    raise exception 'solicitud_no_aprobada: la solicitud % debe ser aprobada por una segunda persona antes de exponer el documento (REQ-SEG-014)', _request_id
      using errcode = 'P0001';
  end if;

  if now() > v_row.expires_at then
    update public.identity_vault_access_request set status = 'expirada', updated_at = now() where id = _request_id;
    raise exception 'solicitud_expirada: la solicitud % venció el % (REQ-SEG-014)', _request_id, v_row.expires_at
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = v_row.identity_ref_id;
  select * into v_vault from public.identity_vault where id = v_ref.vault_id;

  update public.identity_vault_access_request
  set status = 'consumida', consumed_at = now(), updated_at = now()
  where id = _request_id;

  -- Bitácora inmutable de CADA lectura (REQ-SEG-014 "acceso auditado por rol") --
  -- nunca se omite, incluso si la lectura es legítima. Ahora también deja constancia
  -- de quién pidió y quién aprobó, no solo de quién ejecutó la lectura final.
  perform public.record_audit_log(v_row.tenant_id, v_row.hotel_id, 'identity_vault.decrypted', 'identity_ref', v_ref.id,
    jsonb_build_object('reason', v_row.reason, 'requestId', v_row.id, 'approvedBy', v_row.approved_by));

  return query select v_vault.document_number_ciphertext, v_vault.document_number_iv, v_vault.document_number_auth_tag;
end;
$$;

revoke all on function public.reveal_identity_vault_document(uuid) from public;
grant execute on function public.reveal_identity_vault_document(uuid) to atiende_app, authenticated;

-- read_identity_vault_document() (0051) queda reemplazada por el flujo de tres pasos de
-- arriba -- permitía revelar el documento con una sola persona (rol owner/gm) sin que
-- nadie más lo aprobara antes, exactamente el hueco que REQ-SEG-014 pedía cerrar. Se
-- elimina (no se deja como alias/atajo) para que no quede un bypass directo del doble
-- control alcanzable por error o por un caller que no se haya actualizado.
drop function if exists public.read_identity_vault_document(uuid, text);
