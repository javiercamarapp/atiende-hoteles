-- ORIGEN: packages/db/migrations/0015_audit_log_advisory_lock.sql sha256:a9c7bc9be741df7ada4b95bcfc1f6a9263d5194e466410379b0d1f59f6367c24
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H4 · auditoría-1/backend [ALTO]: la cadena de hash de `audit_log` (0008/0012) se
-- puede bifurcar bajo escritura concurrente del MISMO tenant. `audit_log_set_hash()`
-- hacía `select hash ... order by seq desc limit 1` para calcular `prev_hash` y luego
-- insertaba, sin ningún mecanismo que serializara esa lectura-escritura por tenant --
-- dos transacciones concurrentes del mismo tenant (ej. un `reservation.created` y un
-- `payment.recorded` casi simultáneos, el caso real de dos requests de API en paralelo)
-- podían leer el mismo "último hash" antes de que cualquiera insertara, produciendo dos
-- filas con `prev_hash = null` en vez de una cadena, verificado empíricamente en
-- tests/integration/audit-log-concurrencia.spec.ts.
--
-- Primer intento descartado (documentado aquí porque casi se queda sin probar a fondo):
-- `pg_advisory_xact_lock` por tenant ANTES del SELECT. Se probó empíricamente contra
-- `embedded-postgres` real con 20 escrituras concurrentes y SÍ sigue bifurcando la
-- cadena intermitentemente (~1 de cada 3-5 corridas): el advisory lock serializa
-- correctamente el ORDEN de ejecución (verificado con `raise notice`+timestamps -- cada
-- sesión adquiere el lock estrictamente después de que la anterior lo liberó), pero la
-- sentencia `select ... into` que sigue puede seguir viendo una versión no actualizada
-- de "la última fila" en la ventana exacta de la liberación del lock -- un advisory lock
-- por sí solo NO reejecuta ni refresca el plan de la sentencia que sigue.
--
-- Arreglo real: una fila "cabeza de cadena" por tenant (`audit_log_chain_head`),
-- bloqueada con `SELECT ... FOR UPDATE`. A diferencia del advisory lock, `FOR UPDATE` es
-- el mecanismo de Postgres diseñado exactamente para este patrón: si la fila fue
-- modificada por otra transacción entre que la sentencia empezó y logró el lock,
-- Postgres vuelve a evaluarla (EvalPlanQual) y entrega la versión ya comprometida más
-- reciente -- nunca una copia obsoleta. Verificado con la misma prueba de 20 escrituras
-- concurrentes repetida 15+ veces sin ninguna bifurcación.
create table public.audit_log_chain_head (
  tenant_id uuid primary key references public.org(id) on delete cascade,
  hash text
);

-- Siembra la cabeza de cada tenant que ya tenga historial (`audit_log` no está vacía en
-- un entorno de desarrollo/producción que ya haya corrido antes de este arreglo) con su
-- hash más reciente por `seq` -- nunca arranca la cadena desde cero perdiendo el enlace
-- con lo ya escrito.
insert into public.audit_log_chain_head (tenant_id, hash)
select distinct on (tenant_id) tenant_id, hash
from public.audit_log
order by tenant_id, seq desc
on conflict (tenant_id) do nothing;

-- Tabla puramente interna de contabilidad de la cadena: ninguna ruta de aplicación la
-- lee ni la escribe directamente (mismo criterio que `audit_log` con
-- `record_audit_log()`) -- solo el trigger `audit_log_set_hash()`, que corre con el
-- privilegio del propietario de `record_audit_log()` (SECURITY DEFINER, 0008) porque el
-- INSERT que lo dispara ocurre dentro de esa función.
revoke all on public.audit_log_chain_head from public;
alter table public.audit_log_chain_head enable row level security;
-- Sin ninguna policy: `authenticated` queda sin SELECT/INSERT/UPDATE/DELETE directo.

create or replace function public.audit_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_created_at timestamptz;
  v_canonical text;
begin
  -- Garantiza que exista la fila-cabeza de este tenant (primera escritura de su
  -- historia) antes de intentar bloquearla -- `on conflict do nothing` la vuelve segura
  -- ante dos primeras escrituras concurrentes del mismo tenant nuevo.
  insert into public.audit_log_chain_head (tenant_id, hash)
  values (new.tenant_id, null)
  on conflict (tenant_id) do nothing;

  -- FOR UPDATE: bloquea la fila-cabeza de ESTE tenant (nunca la de otros) hasta el
  -- commit/rollback de esta transacción, y entrega SIEMPRE el valor comprometido más
  -- reciente (EvalPlanQual), no una copia tomada antes de esperar el lock.
  select hash into v_prev_hash
  from public.audit_log_chain_head
  where tenant_id = new.tenant_id
  for update;

  v_created_at := coalesce(new.created_at, now());

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

  update public.audit_log_chain_head set hash = new.hash where tenant_id = new.tenant_id;

  return new;
end;
$$;
