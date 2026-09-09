-- H16-014 · REQ-REC-014 (P1/SEG): tabla de alertas de fraude interno detectado
-- cruzando PMS (folio/charge/payment/audit_log, ya reales en este esquema) + POS
-- (F&B -- insumo explícito de quien escanea, sin integración POS real todavía,
-- ADR-007/0031_night_audit.sql "sin_pos_configurado"). Cuatro patrones
-- (public.fraud_pattern, espejo de packages/domain-hotel/src/fraude/deteccion.ts):
-- descuentos fuera de política, folios reabiertos después de auditado, cargos F&B no
-- posteados, reembolsos a una tarjeta distinta de la del cargo. Expand-only sobre el
-- esquema existente (REQ-GOB-011): ninguna migración ya aplicada se edita.

create type public.fraud_pattern as enum (
  'descuento_fuera_de_politica',
  'folio_reabierto_post_auditoria',
  'cargo_fnb_no_posteado',
  'reembolso_tarjeta_distinta'
);

create table public.fraud_alert (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  pattern public.fraud_pattern not null,
  folio_id uuid references public.folio(id) on delete set null,
  charge_id uuid references public.charge(id) on delete set null,
  payment_id uuid references public.payment(id) on delete set null,
  severity text not null default 'alta' check (severity in ('alta')),
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  -- Lista de public.hotel_role destinatarios (REQ-REC-014: "alerta al destinatario
  -- correspondiente"). Se guarda como jsonb (no como `public.hotel_role[]`) a
  -- propósito: este esquema no tiene NINGUNA otra columna de tipo arreglo, y ADR-003
  -- ya documentó que no todo comportamiento de Postgres es idéntico entre PGlite y
  -- embedded-postgres (ver comentario de 0001 sobre pgcrypto) -- jsonb vía
  -- `JSON.stringify` es el mismo patrón, ya probado, que usa `payload`/`evidence` en
  -- audit_log/outbox, sin introducir una superficie nueva sin precedente.
  recipient_roles jsonb not null default '[]'::jsonb,
  -- Clave determinista de idempotencia de escaneo (deteccion.ts, `dedupeKey`):
  -- re-escanear los mismos datos NUNCA duplica la alerta ya generada.
  dedupe_key text not null,
  created_at timestamptz not null default now()
);
create unique index fraud_alert_dedupe_idx on public.fraud_alert (hotel_id, dedupe_key);
create index fraud_alert_tenant_hotel_created_idx on public.fraud_alert (tenant_id, hotel_id, created_at desc);

alter table public.fraud_alert enable row level security;

-- Solo owner/gm/accountant ven TODAS las alertas de fraude (son quienes responden por
-- fraude interno frente al dueño del hotel, mismo criterio que `NIGHT_AUDIT_ROLES` de
-- routes/night-audit.ts); fnb ve además las de su propio patrón operativo
-- (`cargo_fnb_no_posteado`) -- el mismo criterio de "destinatario correspondiente"
-- que exige REQ-REC-014 se aplica aquí también como control de acceso, no solo como
-- enrutamiento de notificación.
create policy "fraud_alert_select" on public.fraud_alert for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
      or (pattern = 'cargo_fnb_no_posteado' and has_hotel_role(hotel_id, array['fnb']::public.hotel_role[]))
    )
  );
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- record_fraud_alert() (SECURITY DEFINER), mismo patrón que record_audit_log (0008) --
-- append-only, ni siquiera el dueño de la fila puede editarla/borrarla directo.

grant select on public.fraud_alert to authenticated;

-- record_fraud_alert(): valida al actor real (cuando existe sesión) contra su propia
-- membresía de tenant/hotel ANTES de insertar -- mismo arreglo que record_audit_log()
-- ya tiene desde 0016 (el CRÍTICO original ahí era exactamente un SECURITY DEFINER
-- que permitía falsificar filas de OTRA organización). `on conflict` sobre
-- `fraud_alert_dedupe_idx`: un re-escaneo del mismo hallazgo NUNCA inserta una
-- segunda fila -- el llamador usa `is_new` para decidir si además despacha una
-- notificación nueva (nunca reenvía la misma alerta dos veces).
create or replace function public.record_fraud_alert(
  _tenant_id uuid,
  _hotel_id uuid,
  _pattern public.fraud_pattern,
  _folio_id uuid,
  _charge_id uuid,
  _payment_id uuid,
  _reason text,
  _evidence jsonb,
  _recipient_roles jsonb,
  _dedupe_key text
)
returns table (id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_id uuid;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_fraud_alert)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if _hotel_id is null or not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (record_fraud_alert)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.fraud_alert
    (tenant_id, hotel_id, pattern, folio_id, charge_id, payment_id, reason, evidence, recipient_roles, dedupe_key)
  values
    (_tenant_id, _hotel_id, _pattern, _folio_id, _charge_id, _payment_id, _reason, _evidence, _recipient_roles, _dedupe_key)
  on conflict (hotel_id, dedupe_key) do nothing
  returning fraud_alert.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select fa.id into v_id from public.fraud_alert fa where fa.hotel_id = _hotel_id and fa.dedupe_key = _dedupe_key;
  return query select v_id, false;
end;
$$;

revoke all on function public.record_fraud_alert(uuid, uuid, public.fraud_pattern, uuid, uuid, uuid, text, jsonb, jsonb, text) from public;
grant execute on function public.record_fraud_alert(uuid, uuid, public.fraud_pattern, uuid, uuid, uuid, text, jsonb, jsonb, text) to atiende_app, authenticated;
