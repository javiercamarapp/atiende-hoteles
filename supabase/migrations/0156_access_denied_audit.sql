-- ORIGEN: packages/db/migrations/0156_access_denied_audit.sql sha256:3f10c73bdd90f1a9d9f986195a58fb4e43af0261787827f31ff10e3850cb9bcd
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- Patrón Likida/atiende.ai #6 ("auditoría del intento de acceso denegado"): el mapa
-- explícito de rutas/roles ya existe (`requireHotelMembership`/`assertRole`,
-- apps/api/src/middleware.ts) y `record_audit_log` (0008) ya se usa extensamente para
-- acciones de negocio EXITOSAS (charge.created, folio.closed, ...), pero ningún 403 se
-- auditaba -- `apps/api/src/app.ts` (`app.onError`) solo llamaba a `deps.logger.error`
-- cuando `status >= 500`. Hoy no queda ningún rastro de quién intentó una acción para
-- la que no tenía permiso.
--
-- `record_access_denied()` es SECURITY DEFINER (mismo patrón que `record_audit_log`,
-- de hecho la reutiliza para el INSERT real) para poder resolver `_hotel_id ->
-- hotel.org_id` (el tenant REAL dueño del hotel) sin depender de que el actor ya
-- pertenezca a ese hotel -- justo el caso más común que dispara un 403 de
-- `requireHotelMembership` (RLS bloquearía un SELECT directo a `public.hotel` para un
-- no-miembro). Sin esto, la fila de auditoría quedaría bajo el tenant EQUIVOCADO (el
-- que el atacante reclama en su JWT) en vez del tenant real del hotel objetivo, y el
-- staff de ese hotel nunca la vería (RLS de audit_log filtra por
-- `current_tenant_ids()`).
create or replace function public.record_access_denied(
  _hotel_id uuid,
  _route text,
  _method text,
  _reason text
)
returns public.audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select org_id into v_org_id from public.hotel where id = _hotel_id;
  if v_org_id is null then
    raise exception 'record_access_denied: hotel_id % no existe', _hotel_id;
  end if;

  return public.record_audit_log(
    v_org_id,
    _hotel_id,
    'access.denied',
    'route',
    null,
    jsonb_build_object('route', _route, 'method', _method, 'reason', _reason)
  );
end;
$$;

revoke all on function public.record_access_denied(uuid, text, text, text) from public;
grant execute on function public.record_access_denied(uuid, text, text, text) to atiende_app, authenticated;
