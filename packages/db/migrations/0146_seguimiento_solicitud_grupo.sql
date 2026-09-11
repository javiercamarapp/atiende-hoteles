-- REQ-RES-013 (P2/F, H02-014/H07-027): "El sistema debe dar seguimiento automático a
-- solicitudes de grupo sin respuesta (48h y 7 días) y requerir validación humana
-- obligatoria antes de enviar cualquier propuesta de RFP." Criterio de aceptación
-- LITERAL (docs/ACEPTACION.md): "Solicitud de grupo sin respuesta recibe seguimiento
-- automático a las 48h y a los 7 días; ninguna propuesta de RFP sale sin un registro de
-- validación humana previa (0 propuestas sin ese registro)."
--
-- REQ-RES-012 (la cotización/contrato/room-block completos de grupos) sigue
-- `pendiente` en `docs/REQUISITOS.md` -- esta migración NO depende de esa pieza: solo
-- necesita el mínimo real para que exista una "solicitud de grupo" con estado de
-- respuesta y un punto de envío de "propuesta de RFP" que pueda gatearse. Cerrar
-- REQ-RES-012 más adelante puede enriquecer `solicitud_grupo` (room block, cut-off,
-- cotización de Revenue) sin romper esta tabla ni su seguimiento.
--
-- 4 tablas nuevas:
--  1) solicitud_grupo: la solicitud del organizador en sí, con su reloj de "sin
--     respuesta" (`creada_en`) y su estado real.
--  2) seguimiento_solicitud_grupo: las 2 filas de seguimiento (48h/7d) que
--     `apps/api/src/routes/grupos.ts` precalcula al crear la solicitud
--     (`computeGroupFollowUpSchedule`, @atiende-hoteles/domain-hotel) y que
--     `apps/api/src/jobs/seguimientoSolicitudGrupo.ts` ejecuta cuando vencen.
--  3) validacion_humana_rfp: el registro de que UN humano (nunca el agente/LLM) revisó
--     la solicitud antes de que salga cualquier propuesta -- append-only.
--  4) propuesta_rfp: la propuesta de RFP enviada, con FK NOT NULL a la validación que
--     la autoriza -- el trigger de abajo es la autoridad real de "0 propuestas sin ese
--     registro" (mismo patrón que `roi_baseline`/`cobro_resultado_activacion`, 0120).

-- 1) Solicitud de grupo ------------------------------------------------------------
create table public.solicitud_grupo (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  organizador_nombre text not null check (length(trim(organizador_nombre)) > 0),
  -- E.164 (mismo criterio de longitud mínima que `guest.phone`/`SendTextMessageInput.to`,
  -- packages/mcp-servers/whatsapp/src/port.ts) -- es el destino real del seguimiento
  -- automático por WhatsApp.
  organizador_telefono text not null check (length(trim(organizador_telefono)) >= 8),
  organizador_email text,
  -- Detalle libre del evento/grupo (tipo, fechas tentativas, número de habitaciones) --
  -- catálogo abierto igual que `roi_event.tipo_evento`: la forma de un RFP de grupo
  -- varía demasiado (boda, congreso, tour operador) para un esquema rígido en esta
  -- primera pieza.
  descripcion text not null check (length(trim(descripcion)) > 0),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'respondida', 'cerrada')),
  -- Inicio real del reloj de "sin respuesta" que exige el REQ -- fijado por la
  -- aplicación al crear la solicitud (normalmente "ahora"), nunca recalculado después
  -- (mismo criterio que `roi_baseline.activado_en`, 0120).
  creada_en timestamptz not null default now(),
  respondida_en timestamptz,
  respondida_por uuid references public.staff_user(id),
  created_by uuid references public.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((estado = 'pendiente') = (respondida_en is null))
);
create index solicitud_grupo_hotel_idx on public.solicitud_grupo (hotel_id, estado);

alter table public.solicitud_grupo enable row level security;

create policy "solicitud_grupo_hotel_select" on public.solicitud_grupo for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
create policy "solicitud_grupo_reservations_insert" on public.solicitud_grupo for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));
create policy "solicitud_grupo_reservations_update" on public.solicitud_grupo for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));
-- Sin policy de DELETE: una solicitud de grupo real nunca se borra, se cierra
-- (`estado = 'cerrada'`) -- mismo criterio append-only que `guest_ticket`/`reservation`.

grant select, insert, update on public.solicitud_grupo to authenticated;

-- 2) Seguimiento automático (48h / 7 días) ------------------------------------------
create table public.seguimiento_solicitud_grupo (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null references public.solicitud_grupo(id) on delete cascade,
  tipo text not null check (tipo in ('48h', '7d')),
  -- = creada_en + 48h / + 7 días -- calculado UNA VEZ por la aplicación
  -- (`computeGroupFollowUpSchedule`) al crear la solicitud, nunca por Postgres, para que
  -- la MISMA fórmula sea la que las pruebas ejercitan con reloj simulado.
  programado_para timestamptz not null,
  ejecutado_en timestamptz,
  -- Detalle del envío real (externalMessageId/canal/si fue simulado) -- mismo criterio
  -- que `roi_event`/`audit_log.payload`: JSON libre, nunca PII del organizador aquí (el
  -- teléfono ya vive en `solicitud_grupo`, no se duplica).
  resultado jsonb,
  created_at timestamptz not null default now(),
  -- Un seguimiento de cada tipo por solicitud -- el job es idempotente por este mismo
  -- unique además de por `ejecutado_en is null` en su WHERE.
  unique (solicitud_id, tipo)
);
create index seguimiento_solicitud_grupo_pendientes_idx
  on public.seguimiento_solicitud_grupo (solicitud_id, ejecutado_en, programado_para);

alter table public.seguimiento_solicitud_grupo enable row level security;

-- SELECT: cualquier staff del hotel de la solicitud (transparencia operativa, mismo
-- criterio que `guest_ticket`) -- vía JOIN a `solicitud_grupo` porque esta tabla no
-- tiene `hotel_id` propio (evita duplicar la columna solo para RLS, igual que
-- `conversation_audit_sample` sí la tiene por necesitarla en sus queries -- aquí el
-- callsite real siempre ya conoce `hotel_id` por el JOIN de `routes/grupos.ts`).
create policy "seguimiento_solicitud_grupo_hotel_select" on public.seguimiento_solicitud_grupo for select to authenticated
  using (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = seguimiento_solicitud_grupo.solicitud_id
        and sg.hotel_id = any (current_hotel_ids())
    )
  );
-- INSERT/UPDATE reales corren desde el job (`engine.admin`, sin sesión `authenticated`,
-- ver `apps/api/src/jobs/seguimientoSolicitudGrupo.ts`) al crear la solicitud y al
-- ejecutar cada seguimiento vencido -- se deja además una vía de aplicación explícita
-- para pruebas/uso manual, mismo criterio que `notification_hotel_insert` (0113).
create policy "seguimiento_solicitud_grupo_hotel_insert" on public.seguimiento_solicitud_grupo for insert to authenticated
  with check (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = seguimiento_solicitud_grupo.solicitud_id
        and has_hotel_role(sg.hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
    )
  );
create policy "seguimiento_solicitud_grupo_hotel_update" on public.seguimiento_solicitud_grupo for update to authenticated
  using (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = seguimiento_solicitud_grupo.solicitud_id
        and has_hotel_role(sg.hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
    )
  )
  with check (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = seguimiento_solicitud_grupo.solicitud_id
        and has_hotel_role(sg.hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
    )
  );

grant select, insert, update on public.seguimiento_solicitud_grupo to authenticated;

-- 3) Validación humana (append-only) ------------------------------------------------
create table public.validacion_humana_rfp (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null references public.solicitud_grupo(id) on delete cascade,
  validado_por uuid not null references public.staff_user(id),
  validado_en timestamptz not null default now(),
  notas text,
  created_at timestamptz not null default now()
);
create index validacion_humana_rfp_solicitud_idx on public.validacion_humana_rfp (solicitud_id);

alter table public.validacion_humana_rfp enable row level security;

create policy "validacion_humana_rfp_hotel_select" on public.validacion_humana_rfp for select to authenticated
  using (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = validacion_humana_rfp.solicitud_id
        and sg.hotel_id = any (current_hotel_ids())
    )
  );
create policy "validacion_humana_rfp_hotel_insert" on public.validacion_humana_rfp for insert to authenticated
  with check (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = validacion_humana_rfp.solicitud_id
        and has_hotel_role(sg.hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
    )
    and validado_por = auth.uid()
  );
-- Sin policy de UPDATE/DELETE: un registro de validación humana es un hecho ocurrido
-- ("esta persona revisó esto a esta hora") -- append-only, mismo criterio que
-- `roi_event`/`audit_log`. Corregir un error exige un registro nuevo, no reescribir el
-- que ya pudo haber autorizado una propuesta.

grant select, insert on public.validacion_humana_rfp to authenticated;

-- 4) Propuesta de RFP ---------------------------------------------------------------
create table public.propuesta_rfp (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null references public.solicitud_grupo(id) on delete cascade,
  -- Referencia REAL a la validación concreta que autoriza ESTA propuesta -- nunca "hubo
  -- alguna validación alguna vez" (mismo criterio que
  -- `cobro_resultado_activacion.roi_baseline_id`, 0120): el trigger de abajo exige que
  -- pertenezca a la MISMA solicitud y sea PREVIA a `enviado_en`.
  validacion_humana_id uuid not null references public.validacion_humana_rfp(id),
  contenido text not null check (length(trim(contenido)) > 0),
  monto_total numeric(12, 2) check (monto_total is null or monto_total >= 0),
  moneda char(3),
  enviado_por uuid references public.staff_user(id),
  enviado_en timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index propuesta_rfp_solicitud_idx on public.propuesta_rfp (solicitud_id);

-- El GATE real (REQ-RES-013, "0 propuestas sin ese registro"): rechaza el INSERT si (a)
-- la validación referenciada no existe, (b) no corresponde a esta misma solicitud, o
-- (c) quedó fechada DESPUÉS del envío de la propuesta (no es "previa"). Ninguna sesión
-- (ni owner/gm, que sí puede escribir la fila por RLS) puede saltarse esto escribiendo
-- SQL a mano -- mismo criterio de autoridad-por-trigger que
-- `cobro_resultado_activacion_guard` (0120)/`roi_baseline_guard` (0120).
create or replace function public.propuesta_rfp_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_validacion public.validacion_humana_rfp%rowtype;
begin
  select * into v_validacion from public.validacion_humana_rfp where id = new.validacion_humana_id;

  if v_validacion.id is null then
    raise exception 'validacion_humana_no_encontrada: el id de validacion humana % no existe -- no se puede enviar una propuesta de RFP sin un registro de validacion humana real (REQ-RES-013)',
      new.validacion_humana_id
      using errcode = 'P0001';
  end if;

  if v_validacion.solicitud_id <> new.solicitud_id then
    raise exception 'validacion_no_corresponde_a_solicitud: la validacion humana % pertenece a la solicitud de grupo %, no a % -- no autoriza esta propuesta',
      new.validacion_humana_id, v_validacion.solicitud_id, new.solicitud_id
      using errcode = 'P0001';
  end if;

  if v_validacion.validado_en > new.enviado_en then
    raise exception 'validacion_posterior_al_envio: la validacion humana % quedo fechada (%) despues del envio de la propuesta (%) -- la validacion debe ser PREVIA',
      new.validacion_humana_id, v_validacion.validado_en, new.enviado_en
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger propuesta_rfp_guard_trg
  before insert on public.propuesta_rfp
  for each row execute function public.propuesta_rfp_guard();

alter table public.propuesta_rfp enable row level security;

create policy "propuesta_rfp_hotel_select" on public.propuesta_rfp for select to authenticated
  using (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = propuesta_rfp.solicitud_id
        and sg.hotel_id = any (current_hotel_ids())
    )
  );
create policy "propuesta_rfp_hotel_insert" on public.propuesta_rfp for insert to authenticated
  with check (
    exists (
      select 1 from public.solicitud_grupo sg
      where sg.id = propuesta_rfp.solicitud_id
        and has_hotel_role(sg.hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
    )
  );
-- Sin policy de UPDATE/DELETE: una propuesta enviada es un hecho append-only, mismo
-- criterio que validacion_humana_rfp/roi_event/audit_log.

grant select, insert on public.propuesta_rfp to authenticated;
