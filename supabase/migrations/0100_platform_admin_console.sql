-- ORIGEN: packages/db/migrations/0100_platform_admin_console.sql sha256:d3610242b757bd9a5bd175c5036fb6cdd89aeca1a2f52a59115ed506fce60499
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12b · LAUNCH-007: consola superadmin cross-tenant. Patrón exacto de
-- `atiende-restaurantes/supabase/migrations/20260904061000_superadmin_platform_rpc.sql`
-- y `likida/src/lib/admin/negocio.ts` (`resumen_negocio()`): UNA sola función
-- `security definer` autorizada a leer a través de todos los tenants a la vez,
-- con el check de rol explícito DENTRO de la función (no solo un GRANT) —
-- exactamente el patrón que docs/auditoria-2/seguridad.md exige para las RPC
-- `security definer` de este repo (LAUNCH-001). Todo lo demás del esquema
-- (hotel_staff, RLS por hotel_id/tenant_id) sigue intacto y aislado: esta
-- migración NO toca ninguna política existente.
--
-- `platform_admin` marca qué `staff_user` es superadmin de PLATAFORMA (Atiende,
-- no de un hotel). Deliberadamente sin policy de insert/update/delete para
-- `authenticated`: dar de alta un superadmin es una decisión humana fuera de la
-- app (docs/runbooks/consola-superadmin.md), nunca autoservicio ni siquiera
-- para un owner de hotel — mismo criterio que "no existe rol/consola
-- superadmin autoservicio" documentado en docs/referencia/08-inventario-
-- punta-a-punta.md fila 12.

create table public.platform_admin (
  user_id uuid primary key references public.staff_user(id) on delete cascade,
  granted_by text not null default 'operacion_manual_db',
  created_at timestamptz not null default now()
);

alter table public.platform_admin enable row level security;

-- SELECT: un usuario solo ve su propia fila (le sirve al frontend para saber "soy
-- superadmin"), nunca la lista completa de superadmins vía RLS directa -- esa lista
-- solo la ve quien opera la base de datos directamente.
create policy "platform_admin_self_select" on public.platform_admin for select to authenticated
  using (user_id = auth.uid());

grant select on public.platform_admin to authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admin where user_id = auth.uid())
$$;

comment on function public.is_platform_admin() is
  'Único punto de verdad de "es superadmin de plataforma" -- usado por admin_negocio(), '
  'admin_reintentar_outbox() y por apps/api/src/routes/admin.ts (defensa en profundidad, '
  'mismo criterio que requireHotelMembership en middleware.ts).';

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to atiende_app, authenticated;

-- Auditoría de accesos del superadmin (parte del entregable LAUNCH-007: "auditoría de
-- accesos del superadmin"): cada lectura/acción cross-tenant vía las funciones de abajo
-- deja un rastro append-only. SELECT reservado a otros superadmins (transparencia entre
-- pares), nunca a staff de hotel.
create table public.platform_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_admin_audit_log_created_idx on public.platform_admin_audit_log (created_at desc);

alter table public.platform_admin_audit_log enable row level security;
create policy "platform_admin_audit_superadmin_select" on public.platform_admin_audit_log for select to authenticated
  using (public.is_platform_admin());
-- Sin policy de insert para `authenticated`: solo las funciones security definer de
-- abajo escriben aquí (corren como el dueño de la función, no como el rol de sesión).

grant select on public.platform_admin_audit_log to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA ÚNICA FUNCIÓN AUTORIZADA A CRUZAR TENANTS (lectura)
-- ═══════════════════════════════════════════════════════════════════════════
-- Agrega SIN exponer PII de huésped: ninguna columna de `guest` ni de
-- `staff_user` sale de aquí fuera de conteos -- mismo criterio que
-- `resumen_negocio()`/`getResumenNegocio` de Likida ("nunca expone filas
-- crudas"). GRANT a `authenticated` (no restringido a un rol de Postgres
-- especial): la autorización real es el `raise exception` de adentro, exactamente
-- el patrón de `is_superadmin`/`can_manage_restaurant` de Restaurantes.
create or replace function public.admin_negocio()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'no_autorizado: se requiere rol superadmin de plataforma' using errcode = '42501';
  end if;

  insert into public.platform_admin_audit_log (actor_id, action, detail)
  values (auth.uid(), 'admin_negocio', '{}'::jsonb);

  select jsonb_build_object(
    'generadoEn', now(),
    'hoteles', (
      select coalesce(jsonb_agg(t order by t.nombre), '[]'::jsonb) from (
        select
          l.id as hotel_id,
          l.name as nombre,
          o.name as org_nombre,
          (select count(*) from public.hotel_staff hs where hs.hotel_id = l.id) as staff_count,
          (select max(r.created_at) from public.reservation r where r.hotel_id = l.id) as ultima_actividad_at,
          (select count(*) from public.reservation r where r.hotel_id = l.id) as reservas_total,
          (select count(*) from public.reservation r where r.hotel_id = l.id and r.status = 'confirmada') as reservas_confirmadas,
          (select coalesce(sum(p.amount), 0) from public.payment p where p.hotel_id = l.id) as ingresos_totales,
          (select coalesce(sum(ar.cost_usd), 0) from public.agent_run ar where ar.hotel_id = l.id and ar.created_at >= date_trunc('month', now())) as costo_ia_mes_usd,
          (select coalesce(sum(ac.monthly_ceiling_usd), 0) from public.agent_config ac where ac.hotel_id = l.id) as techo_ia_mes_usd,
          (select count(*) from public.outbox ob where ob.hotel_id = l.id and ob.status = 'pendiente') as outbox_pendientes,
          (select count(*) from public.outbox ob where ob.hotel_id = l.id and ob.status = 'fallido') as outbox_dead_letter,
          (select count(*) from public.agent_approval aa where aa.hotel_id = l.id and aa.status = 'pendiente' and aa.expires_at < now()) as aprobaciones_vencidas
        from public.hotel h
        join public.location l on l.id = h.id
        join public.org o on o.id = h.org_id
      ) t
    ),
    'metricasGlobales', jsonb_build_object(
      'hotelesTotal', (select count(*) from public.hotel),
      'reservasTotal', (select count(*) from public.reservation),
      'reservasConfirmadasTotal', (select count(*) from public.reservation where status = 'confirmada'),
      'ocupacionMediaHabitaciones', (
        select case when count(*) = 0 then null else
          round(100.0 * count(*) filter (where r.status in ('check_in', 'en_estancia')) / count(*), 1)
        end
        from public.reservation r
      ),
      'ingresosTotales', (select coalesce(sum(amount), 0) from public.payment),
      'costoIaMesUsdTotal', (select coalesce(sum(cost_usd), 0) from public.agent_run where created_at >= date_trunc('month', now())),
      'techoIaMesUsdTotal', (select coalesce(sum(monthly_ceiling_usd), 0) from public.agent_config),
      'outboxPendientesTotal', (select count(*) from public.outbox where status = 'pendiente'),
      'outboxDeadLetterTotal', (select count(*) from public.outbox where status = 'fallido'),
      'aprobacionesVencidasTotal', (select count(*) from public.agent_approval where status = 'pendiente' and expires_at < now())
    ),
    'agentes', (
      select coalesce(jsonb_agg(t order by t.hotel_nombre, t.agent_name), '[]'::jsonb) from (
        select
          ac.hotel_id,
          l.name as hotel_nombre,
          ac.agent_name,
          ac.gate,
          ac.monthly_ceiling_usd,
          (select coalesce(sum(ar.cost_usd), 0) from public.agent_run ar
            where ar.hotel_id = ac.hotel_id and ar.agent_name = ac.agent_name
              and ar.created_at >= date_trunc('month', now())) as costo_mes_usd
        from public.agent_config ac
        join public.location l on l.id = ac.hotel_id
      ) t
    )
  ) into result;

  return result;
end;
$$;

comment on function public.admin_negocio() is
  'LAUNCH-007: consola superadmin cross-tenant. Único punto del esquema que lee a '
  'través de todos los tenants a propósito -- ver comentario de cabecera de esta '
  'migración antes de copiar el patrón a otra función.';

revoke all on function public.admin_negocio() from public;
grant execute on function public.admin_negocio() to atiende_app, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA ÚNICA ESCRITURA OPERATIVA PERMITIDA DESDE /admin (acción explícita, auditada)
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberadamente estrecha: reintentar un evento de outbox en dead-letter
-- (status='fallido' -> 'pendiente') es una operación de infraestructura, NUNCA
-- un cambio a datos de negocio (reserva/folio/cargo/pago) -- el superadmin no
-- tiene, y no debe tener, una función equivalente para esos datos.
create or replace function public.admin_reintentar_outbox(_outbox_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'no_autorizado: se requiere rol superadmin de plataforma' using errcode = '42501';
  end if;

  if not exists (select 1 from public.outbox where id = _outbox_id) then
    raise exception 'outbox_no_encontrado: %', _outbox_id;
  end if;

  update public.outbox
  set status = 'pendiente', available_at = now(), attempts = 0, last_error = null
  where id = _outbox_id;

  insert into public.platform_admin_audit_log (actor_id, action, detail)
  values (auth.uid(), 'admin_reintentar_outbox', jsonb_build_object('outboxId', _outbox_id));
end;
$$;

revoke all on function public.admin_reintentar_outbox(uuid) from public;
grant execute on function public.admin_reintentar_outbox(uuid) to atiende_app, authenticated;
