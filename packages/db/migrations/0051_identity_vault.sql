-- REQ-REC-011/REQ-SEG-014/REQ-SEG-004 · Bóveda de identidad aislada:
--   - `identity_vault`: datos sensibles del documento (número cifrado en reposo --
--     cifrado en CÓDIGO DE APLICACIÓN con AES-256-GCM, ver
--     apps/api/src/lib/identityEncryption.ts; esta tabla nunca ve el texto plano, solo
--     bytes opacos de ciphertext/iv/authTag). RLS habilitada SIN ningún GRANT a
--     `authenticated`: una consulta directa desde cualquier módulo de negocio con una
--     sesión de staff normal es rechazada con "permission denied", nunca con "0 filas"
--     (más fuerte y menos ambiguo que depender solo de una policy vacía). El ÚNICO
--     acceso posible es a través de las dos funciones SECURITY DEFINER de abajo.
--   - `identity_ref`: el subconjunto MÍNIMO que el resto del sistema puede ver (nombre,
--     nacionalidad, tipo de documento, últimos 4 dígitos) -- REQ-REC-011: "exponiendo
--     al resto del sistema solo nombre, nacionalidad, tipo y últimos 4 dígitos del
--     documento". SÍ tiene SELECT para `authenticated` (rol acotado, ver policy).
--
-- Nunca se persiste la imagen del documento en ningún punto (REQ-REC-011 "borrar la
-- imagen ... tras extraer los campos"): esta migración no tiene NINGUNA columna para
-- bytes de imagen -- estructuralmente no hay dónde guardarla aunque alguien lo
-- intentara desde apps/api.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas.

create table public.identity_vault (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  document_number_ciphertext bytea not null,
  document_number_iv bytea not null,
  document_number_auth_tag bytea not null,
  created_at timestamptz not null default now(),
  -- Reloj de retención (REQ-SEG-004 "≤30 días post-checkout"): arranca al checkout,
  -- NULL mientras el huésped sigue en casa (nunca se purga a alguien in-house).
  checkout_at timestamptz,
  retention_days integer not null default 30 check (retention_days > 0)
);
create index identity_vault_tenant_hotel_idx on public.identity_vault (tenant_id, hotel_id);
create index identity_vault_reservation_idx on public.identity_vault (reservation_id);
-- Índice para el job de purga (REQ-SEG-004): filas con checkout_at ya fijado (la purga
-- es un DELETE físico real -- ver apps/api/src/jobs/purgeIdentityVault.ts -- no hay
-- marca de "purgado" que mantener: la fila deja de existir).
create index identity_vault_checkout_idx on public.identity_vault (checkout_at) where checkout_at is not null;

alter table public.identity_vault enable row level security;
-- Deliberadamente SIN ninguna policy ni GRANT a `authenticated`: ver cabecera.

create table public.identity_ref (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  vault_id uuid not null references public.identity_vault(id) on delete cascade,
  full_name text not null,
  nationality text not null,
  document_type text not null check (document_type in ('pasaporte', 'ine', 'otro')),
  document_last4 text not null check (document_last4 ~ '^[A-Za-z0-9]{4}$'),
  created_at timestamptz not null default now()
);
create unique index identity_ref_vault_idx on public.identity_ref (vault_id);
create index identity_ref_tenant_hotel_idx on public.identity_ref (tenant_id, hotel_id);
create index identity_ref_reservation_idx on public.identity_ref (reservation_id);

alter table public.identity_ref enable row level security;
-- Lectura: mismo criterio que MANAGE_RESERVATIONS_ROLES de apps/api/src/domain/roles.ts
-- (owner/gm/frontdesk/reservations -- quienes procesan check-in/identidad del
-- huésped). housekeeping/maintenance/fnb nunca necesitan ver esto.
create policy "identity_ref_tenant_select" on public.identity_ref for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
grant select on public.identity_ref to authenticated;
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- `register_identity_document` (SECURITY DEFINER, abajo).

-- register_identity_document(): único punto de escritura de la bóveda. El número de
-- documento YA llega cifrado (apps/api ya corrió parsePassportMrz + AES-256-GCM antes
-- de llamar aquí) -- esta función NUNCA ve texto plano, solo bytes opacos.
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
  _retention_days integer default 30
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

  -- Mismo criterio que record_audit_log (migración 0016): valida membresía real del
  -- actor SOLO cuando existe una sesión real -- una llamada admin/CLI (seed, job de
  -- purga, tests) sigue funcionando igual, ya es código de plataforma de confianza.
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
    raise exception 'ultimos4_invalidos: debe ser exactamente 4 caracteres alfanuméricos' using errcode = 'P0001';
  end if;

  insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, retention_days)
  values (_tenant_id, _hotel_id, _reservation_id, _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, _retention_days)
  returning id into v_vault_id;

  insert into public.identity_ref (tenant_id, hotel_id, reservation_id, vault_id, full_name, nationality, document_type, document_last4)
  values (_tenant_id, _hotel_id, _reservation_id, v_vault_id, _full_name, _nationality, _document_type, _document_last4)
  returning * into v_ref;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'identity_vault.registered', 'identity_ref', v_ref.id,
    jsonb_build_object('reservationId', _reservation_id, 'documentType', _document_type));

  return v_ref;
end;
$$;

revoke all on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer) from public;
grant execute on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer) to atiende_app, authenticated;

-- read_identity_vault_document(): ÚNICO punto de lectura de los bytes cifrados.
-- Restringido a owner/gm (decisión de alcance de este pase: el "doble control" pleno
-- de REQ-SEG-014 -- dos personas distintas aprobando la misma lectura -- NO está
-- implementado todavía; lo que SÍ se garantiza aquí es acceso restringido por rol +
-- bitácora inmutable de cada lectura vía `record_audit_log`/`audit_log`, que ya es
-- append-only con cadena de hash verificable, migraciones 0008/0012/0015/0016).
create or replace function public.read_identity_vault_document(
  _identity_ref_id uuid,
  _reason text
)
returns table (document_number_ciphertext bytea, document_number_iv bytea, document_number_auth_tag bytea)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_ref public.identity_ref;
  v_vault public.identity_vault;
begin
  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'motivo_requerido: toda lectura de la bóveda de identidad debe documentar un motivo (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = _identity_ref_id;
  if not found then
    raise exception 'identity_ref_no_encontrado: %', _identity_ref_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not has_hotel_role(v_ref.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'acceso_boveda_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_ref.hotel_id
      using errcode = '42501';
  end if;

  select * into v_vault from public.identity_vault where id = v_ref.vault_id;

  -- Bitácora inmutable de CADA lectura (REQ-SEG-014 "acceso auditado por rol") --
  -- nunca se omite, incluso si la lectura es legítima.
  perform public.record_audit_log(v_ref.tenant_id, v_ref.hotel_id, 'identity_vault.decrypted', 'identity_ref', v_ref.id,
    jsonb_build_object('reason', _reason));

  return query select v_vault.document_number_ciphertext, v_vault.document_number_iv, v_vault.document_number_auth_tag;
end;
$$;

revoke all on function public.read_identity_vault_document(uuid, text) from public;
grant execute on function public.read_identity_vault_document(uuid, text) to atiende_app, authenticated;

-- set_identity_checkout(): arranca el reloj de retención al checkout (REQ-SEG-004).
-- Se llama desde el mismo flujo que ya transiciona la reserva a `check_out`
-- (routes/reservas.ts) -- edición mínima ahí, ver apps/api.
create or replace function public.set_identity_checkout(_reservation_id uuid, _checkout_at timestamptz default now())
returns integer
language sql
security definer
set search_path = public
as $$
  update public.identity_vault
  set checkout_at = _checkout_at
  where reservation_id = _reservation_id and checkout_at is null;
  select count(*)::integer from public.identity_vault where reservation_id = _reservation_id and checkout_at is not null;
$$;

revoke all on function public.set_identity_checkout(uuid, timestamptz) from public;
grant execute on function public.set_identity_checkout(uuid, timestamptz) to atiende_app, authenticated;
