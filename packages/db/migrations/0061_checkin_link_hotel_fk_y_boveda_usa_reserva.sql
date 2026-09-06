-- auditoria-2/seguridad [CRITICO] + auditoria-2/datos [CRITICO, reproducido de punta a
-- punta por API real, embedded-postgres]: "El check-in online cruza de hotel: el
-- documento de identidad de un huesped de Hotel B termina en la boveda de Hotel A".
-- `checkin_link.reservation_id` era una FK SIMPLE a `reservation(id)` -- nada impedia
-- `POST /hoteles/{hotelA}/reservas/{reservationIdDeHotelB}/checkin-link`: la policy de
-- INSERT (0054) solo valida que el actor tenga rol de negocio en `:hotelId` (Hotel A),
-- nunca que `:reservationId` pertenezca a ese hotel. Al completarse el enlace,
-- `complete_checkin_public()` sobrescribia el `guest` REAL de Hotel B y archivaba su
-- documento de identidad en la boveda de HOTEL A. Reproducido por auditoria-2/datos con
-- la app Hono real: 201 en ambos pasos, `guest.full_name` de Hotel B quedo sobrescrito.
--
-- Arreglo (mismo patron que D-C1/0018 y 0060): FK COMPUESTA
-- (hotel_id, reservation_id) references reservation(hotel_id, id) sobre `checkin_link`
-- -- el INSERT de arriba ahora es RECHAZADO por el esquema mismo (ninguna sesion, ni
-- siquiera el cliente admin, puede insertar `hotel_id=hotelA` con una `reservation_id`
-- cuyo `hotel_id` real es distinto), sin depender de que la ruta lo valide primero.
--
-- Defensa en profundidad adicional: `complete_checkin_public()` ya NO usa
-- `v_link.hotel_id`/`v_link.tenant_id` (el hotel/org que EMITIO el enlace) para
-- archivar el documento de identidad ni para el audit_log -- usa `v_res.hotel_id`/
-- `v_res.tenant_id` (el hotel/org REAL de la reserva). Con la FK compuesta de arriba
-- ambos valores siempre coinciden hoy, pero esto evita que un futuro cambio de esquema
-- que debilite la FK (o un `ON DELETE`/migracion de datos) reabra la fuga en silencio
-- -- "la boveda escribe con el hotel de la reserva, nunca del enlace/cliente".
alter table public.reservation
  add constraint reservation_hotel_id_id_key unique (hotel_id, id);

alter table public.checkin_link
  add constraint checkin_link_reservation_hotel_fk
  foreign key (hotel_id, reservation_id) references public.reservation (hotel_id, id) on delete cascade;

create index checkin_link_hotel_reservation_idx on public.checkin_link (hotel_id, reservation_id);

-- El RETURNS TABLE gana dos columnas (hotel_id, tenant_id) -- Postgres no permite
-- CREATE OR REPLACE cuando cambia el tipo de retorno de una funcion existente, hay que
-- DROP primero (mismo cuerpo/permisos se re-crean acto seguido, ninguna migracion ya
-- aplicada se edita: esta migracion es nueva).
drop function if exists public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea);

create function public.complete_checkin_public(
  _token text,
  _full_name text,
  _email text,
  _phone text,
  _eta_estimada timestamptz,
  _rfc text,
  _signature_data_url text,
  _document_type text,
  _nationality text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea
)
returns table (submission_id uuid, reservation_id uuid, hotel_id uuid, tenant_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.checkin_link;
  v_res public.reservation;
  v_identity_ref_id uuid;
  v_submission_id uuid;
begin
  select * into v_link from public.checkin_link where token = _token for update;
  if not found then
    raise exception 'checkin_link_no_encontrado: el enlace de check-in no existe' using errcode = 'P0001';
  end if;

  if v_link.status = 'completado' then
    raise exception 'checkin_link_ya_usado: este enlace de check-in ya fue utilizado (de un solo uso)'
      using errcode = 'P0001';
  end if;

  if v_link.expires_at < now() then
    update public.checkin_link set status = 'expirado' where id = v_link.id and status = 'pendiente';
    raise exception 'checkin_link_expirado: este enlace de check-in ya vencio' using errcode = 'P0001';
  end if;

  if _signature_data_url is null or length(trim(_signature_data_url)) = 0 then
    raise exception 'firma_requerida: la firma de registro es obligatoria' using errcode = 'P0001';
  end if;

  select * into v_res from public.reservation where id = v_link.reservation_id;
  if not found then
    raise exception 'reserva_no_encontrada: la reserva del enlace de check-in ya no existe' using errcode = 'P0001';
  end if;

  -- Alias explicito `g` para evitar ambiguedad plpgsql: `hotel_id` es tambien una
  -- columna del RETURNS TABLE de esta funcion (declarada implicitamente como variable
  -- de salida) -- sin alias, "hotel_id" a secas en el WHERE es ambiguo entre esa
  -- variable y la columna de `guest` (errcode 42702, confirmado en pruebas).
  update public.guest g
  set full_name = coalesce(nullif(trim(_full_name), ''), g.full_name),
      email = coalesce(nullif(trim(_email), ''), g.email),
      phone = coalesce(nullif(trim(_phone), ''), g.phone)
  where g.id = v_res.guest_id and g.hotel_id = v_res.hotel_id;

  -- Usa SIEMPRE el hotel/org de la RESERVA (v_res), nunca los del enlace (v_link) --
  -- ver cabecera de esta migracion. Con la FK compuesta de arriba ambos ya coinciden
  -- estructuralmente, esto es defensa en profundidad.
  select r.id into v_identity_ref_id
  from public.register_identity_document(
    v_res.tenant_id, v_res.hotel_id, v_res.id, _full_name, _nationality, _document_type, _document_last4,
    _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, 30
  ) r;

  update public.guest g
  set identity_ref = v_identity_ref_id, document_type = _document_type, document_last4 = _document_last4
  where g.id = v_res.guest_id and g.hotel_id = v_res.hotel_id;

  insert into public.checkin_submission
    (tenant_id, hotel_id, reservation_id, checkin_link_id, eta_estimada, rfc, signature_data_url, identity_ref_id)
  values
    (v_res.tenant_id, v_res.hotel_id, v_res.id, v_link.id, _eta_estimada, _rfc, _signature_data_url, v_identity_ref_id)
  returning id into v_submission_id;

  update public.checkin_link set status = 'completado', completed_at = now() where id = v_link.id;

  perform public.record_audit_log(v_res.tenant_id, v_res.hotel_id, 'checkin_online.completed', 'checkin_link', v_link.id,
    jsonb_build_object('reservationId', v_res.id, 'submissionId', v_submission_id));

  return query select v_submission_id, v_res.id, v_res.hotel_id, v_res.tenant_id;
end;
$$;

revoke all on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) from public;
grant execute on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) to atiende_app, authenticated;
