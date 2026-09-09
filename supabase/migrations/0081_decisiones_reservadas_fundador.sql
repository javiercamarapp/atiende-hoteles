-- ORIGEN: packages/db/migrations/0081_decisiones_reservadas_fundador.sql sha256:bea32bfb8a5cdcb4477db6de931361c44bbc6e1f4f000d14487d0cae0c1bd1d1
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-GOB-012 (fuentes GOB-051/GOB-052/BP-066/BP-082/BP-145/BP-150/LLM-022/BP-065/
-- H18-004): "existe un catálogo cerrado de decisiones reservadas exclusivamente al
-- fundador humano ... cualquier cambio en estos dominios requiere aprobación explícita
-- registrada del fundador antes de mergear/ejecutar". Hasta esta migración el catálogo
-- vivía SOLO como prosa (`docs/REQUISITOS.md` §3.16, `docs/BLOQUEOS.md`) — ningún cambio
-- real en ninguno de esos dominios estaba bloqueado por nada más que la buena voluntad
-- de quien escribiera el código (`docs/TRAZABILIDAD.md:156`: "formalizarlo como registro
-- de aprobaciones verificable en código es un proyecto propio").
--
-- IMPORTANTE — qué es "el fundador" en este esquema: NINGÚN rol existente (`hotel_role`:
-- owner/gm/frontdesk/... , 0003) lo representa. `owner` es el dueño/gerente de UN
-- hotel-cliente (un tenant/`org` de la plataforma) — un CLIENTE de atiende-hoteles, no
-- quien opera la plataforma. "El fundador" (Javier) es una identidad de PLATAFORMA, por
-- encima de todas las orgs, que hoy no existe en el esquema — se introduce aquí
-- (`founder_identity`) como tabla separada, deliberadamente sin ningún camino de
-- autoservicio para nombrarse a sí mismo (igual que el alta de `org`/`hotel`, ver 0010:
-- "alta de org/hotel es operación de plataforma fuera de alcance de H1, se hace con el
-- rol propietario" — mismo criterio aquí).
--
-- Diseño (3 piezas):
--   1. `founder_reserved_category` (enum): el catálogo CERRADO en sí — 24 categorías,
--      una por cada dominio listado en REQ-GOB-012/ACEPTACION.md, citado en el comentario
--      de cada valor. Cerrado de verdad: Postgres rechaza cualquier valor fuera de esta
--      lista con un error real (`invalid input value for enum`), no una validación de
--      aplicación que un camino nuevo pueda saltarse.
--   2. `founder_identity` + `is_founder()`: quién SÍ es el fundador (0..n filas, en la
--      práctica 1). Sin GRANT de insert/update/delete a `authenticated` — nombrar a un
--      fundador nunca es alcanzable desde ninguna sesión de aplicación, solo con el rol
--      admin/superusuario del motor (igual que alta de org/hotel).
--   3. `founder_decision_approval` (registro, inmutable salvo revocar) +
--      `has_founder_decision_approval()`/`require_founder_decision_approval()`: el gate
--      genérico reutilizable por cualquier tabla/función del dominio. Alcance por
--      (categoría, org_id NULL=plataforma completa, hotel_id NULL=toda la org).
--
-- Dos superficies REALES ya existentes quedan gateadas por esto en esta misma migración
-- (verificación con datos reales, no solo el mecanismo abstracto):
--   - `register_identity_document()` (0067): extender retención de identidad >30 días
--     hoy solo exige rol owner/gm + motivo — REQ-GOB-012 lista "retención de identidad
--     >30 días" explícitamente como decisión reservada al fundador, no al owner/gm de un
--     hotel-cliente. Se añade el requisito de aprobación del fundador SOBRE el requisito
--     existente (no lo reemplaza).
--   - `agent_config` (0025): pasar el agente de revenue/cierre (`auditor_nocturno`) a
--     `autopilot` hoy solo exige rol owner/gm — REQ-GOB-012 lista "paso de revenue de
--     shadow a autopilot" explícitamente. Se añade un trigger que exige la aprobación
--     ANTES de aceptar ese cambio de gate para ESE agente (los demás agentes, sin tocar
--     revenue directamente, siguen gobernados solo por owner/gm como hasta ahora).
-- Para el resto de las categorías (sin tabla de dominio propia hoy — marca/dominio,
-- proveedor de modelo/telefonía/BD, partner PMS/CM, etc.) se introduce
-- `founder_reserved_setting`: una tabla de configuración genérica por categoría cuyo
-- propio trigger de escritura exige la misma aprobación — el mismo mecanismo, aplicable
-- de inmediato a cualquiera de las 24 categorías sin esperar a que cada una tenga su
-- propia tabla de dominio.

-- 1) Catálogo cerrado -----------------------------------------------------------------
create type public.founder_reserved_category as enum (
  'precios_de_lista',                            -- precios de lista
  'contratos_terceros',                          -- contratos con terceros
  'flujos_dinero_terceros_o_efirma',              -- flujos de dinero de terceros/e.firma
  'retencion_o_biometria',                       -- retención/biometría (política general)
  'outbound_internacional',                      -- outbound internacional
  'modo_autonomo_sensible',                      -- modo autónomo sensible (reseñas ≤3★/reembolsos/reclutamiento/compras sobre umbral/tarifas)
  'cambio_proveedor_modelo_telefonia_bd',        -- cambio de proveedor de modelo/telefonía/BD
  'migracion_livekit_selfhost',                  -- migración a LiveKit self-host
  'borrado_destructivo_o_force_push',            -- borrado destructivo/force-push
  'marca_dominio_o_legal',                       -- marca/dominio/legal
  'impacto_reputacional_externo',                -- acciones con impacto reputacional externo
  'contratacion_despido_o_compensacion',         -- contratación/despido/compensación
  'control_fisico_ac_cerraduras_llaves',         -- control físico AC/cerraduras/llaves
  'shadow_a_autopilot_revenue',                  -- paso de revenue de shadow a autopilot
  'datos_de_otros_hoteles_cliente',              -- uso de datos de otros hoteles-cliente
  'retencion_identidad_mayor_30_dias',           -- retención de identidad >30 días
  'cobro_vcc_disputas_o_declaraciones_fiscales', -- cobro de VCC/disputas/declaraciones fiscales
  'partner_pms_o_cm',                            -- programas de partner PMS/CM
  'compra_de_hardware_o_esco',                   -- compra/financiamiento de hardware/ESCO
  'estructura_de_exito_compartido',              -- estructura de éxito compartido
  'modo_sin_recepcion_nocturna',                 -- modo "sin recepción nocturna"
  'reduccion_de_plantilla',                      -- reducción de plantilla
  'protocolos_de_huracan',                       -- protocolos de huracán
  'abandono_de_lovable_o_convivencia_con_repo'   -- abandono de Lovable o convivencia con el repositorio de código
);

-- 2) Identidad del fundador -------------------------------------------------------------
create table public.founder_identity (
  user_id uuid primary key references public.staff_user(id) on delete restrict,
  full_name text not null,
  created_at timestamptz not null default now()
);

alter table public.founder_identity enable row level security;
-- Transparencia mínima (cualquier sesión puede verificar QUIÉN es el fundador), nunca
-- escritura: alta/baja de fundador es una operación de plataforma que solo el rol
-- admin/superusuario del motor puede hacer (fuera de RLS), igual que alta de org/hotel.
create policy "founder_identity_select" on public.founder_identity for select to authenticated
  using (true);

grant select on public.founder_identity to authenticated;
-- Deliberadamente SIN insert/update/delete a `authenticated`: ni siquiera un owner
-- puede nombrarse (o nombrar a otro) fundador desde ningún camino de la aplicación.

create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.founder_identity where user_id = auth.uid())
$$;

revoke all on function public.is_founder() from public;
grant execute on function public.is_founder() to atiende_app, authenticated;

-- 3) Registro de aprobaciones (el gate genérico) ----------------------------------------
create table public.founder_decision_approval (
  id uuid primary key default gen_random_uuid(),
  category public.founder_reserved_category not null,
  -- NULL = aplica a TODA la plataforma (todas las orgs); un valor = solo esa org.
  org_id uuid references public.org(id) on delete cascade,
  -- NULL = aplica a TODOS los hoteles del alcance de arriba; un valor = solo ese hotel.
  hotel_id uuid references public.hotel(id) on delete cascade,
  decided_by uuid not null references public.staff_user(id),
  decided_at timestamptz not null default now(),
  -- GOB-026: texto EXACTO que el fundador aprobó (nunca un resumen/paráfrasis posterior
  -- de otra persona) -- mismo criterio que `agent_approval.texto_mostrado` (0042).
  texto_exacto text not null check (length(trim(texto_exacto)) > 0),
  detail jsonb not null default '{}'::jsonb,
  revoked_at timestamptz,
  revoked_by uuid references public.staff_user(id),
  created_at timestamptz not null default now(),
  check (hotel_id is null or org_id is not null),
  check ((revoked_at is null) = (revoked_by is null))
);
create index founder_decision_approval_lookup_idx
  on public.founder_decision_approval (category, org_id, hotel_id)
  where revoked_at is null;

create or replace function public.founder_decision_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_hotel_org uuid;
begin
  v_actor := auth.uid();

  if new.hotel_id is not null then
    if new.org_id is null then
      raise exception 'hotel_sin_org: no se puede aprobar una decision a nivel de un solo hotel sin especificar org_id'
        using errcode = 'P0001';
    end if;
    select org_id into v_hotel_org from public.hotel where id = new.hotel_id;
    if v_hotel_org is null or v_hotel_org <> new.org_id then
      raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', new.hotel_id, new.org_id
        using errcode = '23514';
    end if;
  end if;

  if TG_OP = 'INSERT' then
    if v_actor is not null then
      -- decided_by nunca lo controla el cliente cuando hay sesion real -- se deriva del
      -- actor autenticado, igual que `record_audit_log` deriva `actor_user_id` (0008).
      new.decided_by := v_actor;
    end if;
    if new.revoked_at is not null or new.revoked_by is not null then
      raise exception 'aprobacion_no_puede_nacer_revocada: revoked_at/revoked_by deben ser NULL al insertar'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE': la UNICA escritura permitida sobre una fila existente es
  -- revocarla (revoked_at/revoked_by) -- inmutable en todo lo demas, igual que
  -- audit_log. Un fundador que cambio de opinion registra una revocacion (y, si aplica,
  -- una fila NUEVA con la decision correcta) en vez de reescribir la historia.
  if new.category is distinct from old.category
    or new.org_id is distinct from old.org_id
    or new.hotel_id is distinct from old.hotel_id
    or new.decided_by is distinct from old.decided_by
    or new.decided_at is distinct from old.decided_at
    or new.texto_exacto is distinct from old.texto_exacto
    or new.detail is distinct from old.detail
  then
    raise exception 'aprobacion_inmutable: una aprobacion del fundador ya registrada solo puede revocarse (revoked_at/revoked_by), nunca reescribirse'
      using errcode = 'P0001';
  end if;
  if v_actor is not null then
    new.revoked_by := v_actor;
  end if;
  return new;
end;
$$;

create trigger founder_decision_approval_guard_trg
  before insert or update on public.founder_decision_approval
  for each row execute function public.founder_decision_approval_guard();

alter table public.founder_decision_approval enable row level security;

create policy "founder_decision_approval_select" on public.founder_decision_approval for select to authenticated
  using (org_id is null or org_id = any (current_tenant_ids()) or public.is_founder());

-- INSERT/UPDATE: EXCLUSIVAMENTE el fundador -- es la forma mas literal de "cualquier
-- cambio en estos dominios sin aprobacion registrada del fundador es bloqueado": ni
-- owner ni gm de ninguna org (sin importar el rol que tengan en su propio hotel) puede
-- registrar NI revocar una aprobacion de este catalogo.
create policy "founder_decision_approval_insert" on public.founder_decision_approval for insert to authenticated
  with check (public.is_founder());
create policy "founder_decision_approval_update" on public.founder_decision_approval for update to authenticated
  using (public.is_founder())
  with check (public.is_founder());
-- Sin policy de delete: inmutable, igual que audit_log -- una aprobacion se revoca
-- (revoked_at), nunca se borra.

grant select, insert, update on public.founder_decision_approval to authenticated;

create or replace function public.has_founder_decision_approval(
  _category public.founder_reserved_category,
  _org_id uuid default null,
  _hotel_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Una aprobacion cubre el intento cuando su alcance es igual o MAS AMPLIO que el
  -- intento: org_id NULL (plataforma) cubre cualquier org; hotel_id NULL (toda la org)
  -- cubre cualquier hotel de esa org. Nunca al reves (una aprobacion mas ESTRECHA que
  -- el intento no lo cubre).
  select exists (
    select 1
    from public.founder_decision_approval a
    where a.category = _category
      and a.revoked_at is null
      and (a.org_id is null or a.org_id = _org_id)
      and (a.hotel_id is null or a.hotel_id = _hotel_id)
  )
$$;

revoke all on function public.has_founder_decision_approval(public.founder_reserved_category, uuid, uuid) from public;
grant execute on function public.has_founder_decision_approval(public.founder_reserved_category, uuid, uuid) to atiende_app, authenticated;

create or replace function public.require_founder_decision_approval(
  _category public.founder_reserved_category,
  _org_id uuid default null,
  _hotel_id uuid default null
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_founder_decision_approval(_category, _org_id, _hotel_id) then
    raise exception 'aprobacion_fundador_requerida: la categoria "%" (REQ-GOB-012, catalogo cerrado de decisiones reservadas al fundador) no tiene una aprobacion del fundador registrada y vigente para este alcance', _category
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.require_founder_decision_approval(public.founder_reserved_category, uuid, uuid) from public;
grant execute on function public.require_founder_decision_approval(public.founder_reserved_category, uuid, uuid) to atiende_app, authenticated;

-- 4) Superficie genérica para categorías sin tabla de dominio propia -------------------
-- Config por (categoria, alcance, key) -- ej. category='cambio_proveedor_modelo_telefonia_bd',
-- key='model_provider'. Cualquier INSERT/UPDATE pasa por el trigger de abajo, que exige
-- la aprobacion vigente ANTES de aceptar el valor nuevo -- el mismo mecanismo sirve para
-- las 24 categorias sin esperar a que cada una tenga su propia tabla de dominio.
create table public.founder_reserved_setting (
  id uuid primary key default gen_random_uuid(),
  category public.founder_reserved_category not null,
  org_id uuid references public.org(id) on delete cascade,
  hotel_id uuid references public.hotel(id) on delete cascade,
  key text not null check (length(trim(key)) > 0),
  value jsonb not null,
  updated_by uuid references public.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (hotel_id is null or org_id is not null)
);
-- Unicidad por (categoria, alcance, key) tratando NULL como un valor de alcance mas
-- (coalesce a un sentinel) -- una unique constraint normal no lo lograria (NULL <> NULL
-- en Postgres, dos filas org_id=NULL "no chocarian" bajo una unique constraint comun).
create unique index founder_reserved_setting_scope_key_idx
  on public.founder_reserved_setting (
    category,
    coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid),
    key
  );

create or replace function public.founder_reserved_setting_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hotel_org uuid;
begin
  if new.hotel_id is not null then
    if new.org_id is null then
      raise exception 'hotel_sin_org: founder_reserved_setting.hotel_id no puede fijarse sin org_id'
        using errcode = 'P0001';
    end if;
    select org_id into v_hotel_org from public.hotel where id = new.hotel_id;
    if v_hotel_org is null or v_hotel_org <> new.org_id then
      raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', new.hotel_id, new.org_id
        using errcode = '23514';
    end if;
  end if;

  perform public.require_founder_decision_approval(new.category, new.org_id, new.hotel_id);

  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger founder_reserved_setting_guard_trg
  before insert or update on public.founder_reserved_setting
  for each row execute function public.founder_reserved_setting_guard();

alter table public.founder_reserved_setting enable row level security;

create policy "founder_reserved_setting_select" on public.founder_reserved_setting for select to authenticated
  using (org_id is null or org_id = any (current_tenant_ids()) or public.is_founder());

-- Escritura: el fundador siempre puede (es quien aprobo la categoria); un owner/gm de
-- UN hotel especifico puede aplicar el valor una vez que la aprobacion ya existe (el
-- trigger de arriba la exige de todos modos) pero solo para configuracion de SU hotel
-- -- nunca para una fila a nivel de plataforma/org completa (hotel_id NULL), que exige
-- ser el fundador.
create policy "founder_reserved_setting_insert" on public.founder_reserved_setting for insert to authenticated
  with check (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  );
create policy "founder_reserved_setting_update" on public.founder_reserved_setting for update to authenticated
  using (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  )
  with check (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  );

grant select, insert, update on public.founder_reserved_setting to authenticated;

-- 5) Superficies REALES ya existentes, gateadas ahora por el catalogo -------------------

-- 5a) `register_identity_document()` (0067): extender retencion de identidad >30 dias
-- ya exigia rol owner/gm + motivo; REQ-GOB-012 la lista explicitamente como decision
-- reservada al FUNDADOR (no al owner/gm de un hotel-cliente cualquiera) -- se añade el
-- requisito ENCIMA del que ya existia (defensa en profundidad, ninguno reemplaza al
-- otro). Misma firma que 0067: ninguna ruta que ya la invoca cambia.
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
    if v_actor is not null then
      if not has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
        raise exception 'rol_no_autorizado: extender la retencion mas alla de 30 dias requiere rol owner/gm en el hotel %', _hotel_id
          using errcode = '42501';
      end if;
      -- REQ-GOB-012: "retencion de identidad >30 dias" es decision reservada al
      -- fundador -- owner/gm del hotel-cliente ya no basta por si solo.
      perform public.require_founder_decision_approval('retencion_identidad_mayor_30_dias', _tenant_id, _hotel_id);
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

-- 5b) `agent_config` (0025): pasar `auditor_nocturno` (el UNICO agente etiquetado
-- "revenue/cierre" en el catalogo, `packages/agent-core/src/agents.ts`) a `autopilot`
-- es exactamente "shadow -> autopilot de revenue" -- se exige la aprobacion ANTES de
-- aceptar ese valor. Los demas agentes (`recepcion_virtual`, `enrutador_mensajes`) NO
-- tocan revenue directamente y siguen gobernados solo por la RLS owner/gm existente
-- (0025) -- ver tests/integration/api/agentes.spec.ts y
-- tests/adversarial/agentes-aislamiento.spec.ts, que ya suben `recepcion_virtual` a
-- autopilot sin pasar por este trigger; no se alteran.
create or replace function public.agent_config_shadow_a_autopilot_revenue_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_name = 'auditor_nocturno' and new.gate = 'autopilot' then
    perform public.require_founder_decision_approval('shadow_a_autopilot_revenue', new.org_id, new.hotel_id);
  end if;
  return new;
end;
$$;

create trigger agent_config_shadow_a_autopilot_revenue_guard_trg
  before insert or update on public.agent_config
  for each row execute function public.agent_config_shadow_a_autopilot_revenue_guard();
