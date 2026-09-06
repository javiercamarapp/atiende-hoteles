-- ORIGEN: packages/db/migrations/0067_identity_vault_retencion_extendida_justificada.sql sha256:bef85c8fea6a29f6ae4768d725dc7d9c65fef539ab5b8225f84282a6d1fc450a
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-2/legal [ALTO]: "Cualquier frontdesk puede fijar 365 dias de retencion de
-- un documento de identidad sin justificar el motivo ni dejarlo en la bitacora".
-- `retencionDias` (1..365) se aceptaba de cualquier rol de `MANAGE_RESERVATIONS_ROLES`
-- (incluye frontdesk) sin exigir motivo, y el audit_log de `register_identity_document`
-- nunca guardaba que retencion se eligio. REQ-SEG-004/REQ-REC-011 fijan "<=30 dias
-- post-checkout salvo obligacion distinta" -- la excepcion presupone una obligacion
-- identificable y documentada, no una eleccion libre sin registro del motivo.
--
-- Arreglo (en la base, defensa en profundidad -- la ruta apps/api sigue pudiendo
-- agregar su propio chequeo de rol adicional, pero el esquema ya no depende solo de
-- eso): `register_identity_document()` ahora exige, cuando `_retention_days > 30`, un
-- `_retention_reason` no vacio Y (cuando hay sesion real) que el actor tenga rol
-- owner/gm -- no basta frontdesk/reservations para extender mas alla del default legal.
-- El motivo elegido queda en la nueva columna `identity_vault.retention_reason` y en el
-- payload de `audit_log` de cada registro (antes solo guardaba reservationId/
-- documentType).
alter table public.identity_vault add column retention_reason text;

create or replace function public.register_identity_document(
  _tenant_id uuid,
  _hotel_id uuid,
  _reservation_id uuid,
  _full_name text,
  _nationality text,
  _document_type text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea,
  _retention_days integer default 30,
  _retention_reason text default null
)
returns public.identity_ref
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_vault_id uuid;
  v_ref public.identity_ref;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (register_identity_document)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (register_identity_document)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
    if not has_hotel_role(_hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: el actor % no tiene un rol autorizado para registrar identidad en el hotel %', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  if _document_type not in ('pasaporte', 'ine', 'otro') then
    raise exception 'tipo_documento_invalido: "%" no es pasaporte/ine/otro', _document_type using errcode = 'P0001';
  end if;
  if _document_last4 !~ '^[A-Za-z0-9]{4}$' then
    raise exception 'ultimos4_invalidos: debe ser exactamente 4 caracteres alfanumericos' using errcode = 'P0001';
  end if;

  if coalesce(_retention_days, 30) > 30 then
    if _retention_reason is null or length(trim(_retention_reason)) = 0 then
      raise exception 'motivo_retencion_requerido: una retencion mayor a 30 dias exige justificar el motivo (REQ-SEG-004)'
        using errcode = 'P0001';
    end if;
    if v_actor is not null and not has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: extender la retencion mas alla de 30 dias requiere rol owner/gm en el hotel %', _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, retention_days, retention_reason)
  values (_tenant_id, _hotel_id, _reservation_id, _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, coalesce(_retention_days, 30), _retention_reason)
  returning id into v_vault_id;

  insert into public.identity_ref (tenant_id, hotel_id, reservation_id, vault_id, full_name, nationality, document_type, document_last4)
  values (_tenant_id, _hotel_id, _reservation_id, v_vault_id, _full_name, _nationality, _document_type, _document_last4)
  returning * into v_ref;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'identity_vault.registered', 'identity_ref', v_ref.id,
    jsonb_build_object('reservationId', _reservation_id, 'documentType', _document_type, 'retentionDays', coalesce(_retention_days, 30), 'retentionReason', _retention_reason));

  return v_ref;
end;
$$;

revoke all on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) from public;
grant execute on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) to atiende_app, authenticated;

-- La firma anterior (sin _retention_reason) queda sin uso por apps/api tras este
-- cambio -- se elimina para que no queden dos sobrecargas divergentes de la misma
-- funcion (una validando motivo, otra no) alcanzables por error.
drop function if exists public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer);
