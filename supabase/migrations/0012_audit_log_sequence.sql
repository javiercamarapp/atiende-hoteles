-- ORIGEN: packages/db/migrations/0012_audit_log_sequence.sql sha256:00ce5f63440c40350ce47e97b2f907aa312de9c0b584b2561dc947e3feda0034
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H2 · Corrige un desempate no determinista en `audit_log_set_hash()` (0008): el
-- trigger elegia la fila "anterior" con `order by created_at desc, id desc limit 1`,
-- pero `id` es un UUID aleatorio (gen_random_uuid()) sin relacion con el orden real de
-- insercion. Cuando dos inserciones del MISMO tenant caen en el mismo `created_at`
-- (resolucion de reloj, perfectamente posible bajo carga real de la API o en pruebas
-- rapidas en PGlite/embedded-postgres), el desempate por `id` podia romper la cadena de
-- hash (prev_hash apuntando a la fila "equivocada"), detectado por
-- tests/unit/audit-log.spec.ts de forma intermitente.
--
-- Se agrega una columna `seq` estrictamente monotona (identity, asignada por Postgres
-- de forma atomica en cada INSERT, ANTES de que corra el trigger BEFORE INSERT) para
-- desempatar por orden real de insercion en vez de por UUID. No cambia la formula del
-- hash en si (mismas columnas que 0008: prev_hash|tenant|hotel|actor|action|entity_type|
-- entity_id|payload|created_at) -- solo corrige COMO se localiza la fila anterior, por lo
-- que las cadenas de hash ya generadas siguen siendo verificables con la misma formula.
alter table public.audit_log add column seq bigint generated always as identity;
create unique index audit_log_seq_idx on public.audit_log (seq);
create index audit_log_tenant_seq_idx on public.audit_log (tenant_id, seq);

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
  order by seq desc
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
