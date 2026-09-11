-- ORIGEN: packages/db/migrations/0130_programa_lealtad_beneficios.sql sha256:99096a5265a88d99ef54ee17c5cb40e2c99f2eedfdc0e02aa99f65caddf26ac7
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-CRM-008 (P2/F): "programa de lealtad propio (tarifa directa con descuento, late
-- checkout, crédito F&B, reconocimiento) gestionado desde CRM/WhatsApp" (H05-010).
--
-- El beneficio "tarifa directa con descuento" YA existe y está probado end-to-end
-- (REQ-RES-010, migración 0123: `hotel_loyalty_program_config.discount_pct` +
-- `hotel_loyalty_member`, aplicado automáticamente en `POST .../reservas` vía
-- `computeLoyaltyBenefitForNewReservation`). Este REQ es el programa de lealtad
-- COMPLETO del que ese descuento es un beneficio: reutiliza la MISMA fila de
-- membresía (un huésped tiene una sola membresía de lealtad por hotel, no una por
-- beneficio) y agrega los 3 beneficios restantes del criterio de aceptación
-- (late checkout, crédito F&B, reconocimiento) más el registro de cuándo un miembro
-- realmente los obtuvo -- el criterio de aceptación exige verificar "un huésped
-- miembro obteniendo el beneficio configurado", no solo que exista la configuración.
--
-- Los 3 beneficios nuevos se CANJEAN (una acción puntual que el staff registra desde
-- el CRM o desde la bandeja de WhatsApp -- `canal` abajo), a diferencia del descuento
-- de tarifa directa que se APLICA automáticamente en cada reserva directa. Fail-closed
-- igual que el resto del programa (0123): sin config o sin membresía activa, el
-- cálculo de elegibilidad (`packages/domain-hotel/src/reservas/programaLealtad.ts`)
-- rechaza el canje ANTES de que este módulo intente insertar nada.

-- Extiende la config existente (mismo patrón 1-fila-por-hotel que 0123) con los 3
-- beneficios nuevos. Cada uno es NULLABLE = "beneficio no configurado/deshabilitado"
-- (fail-closed: nunca se ofrece un beneficio que nadie fijó explícitamente, mismo
-- criterio que `discount_pct` default 10 pero aquí sin default porque estos 3 no
-- tienen un valor "sensato" universal como sí lo tiene un descuento).
alter table public.hotel_loyalty_program_config
  add column late_checkout_hours smallint check (late_checkout_hours is null or late_checkout_hours between 1 and 6),
  add column fnb_credit_amount numeric(10, 2) check (fnb_credit_amount is null or fnb_credit_amount >= 0),
  add column reconocimiento_texto text check (reconocimiento_texto is null or length(trim(reconocimiento_texto)) > 0);

-- Ledger de canjes: append-only (nunca se actualiza/borra una fila -- es el historial
-- real de "quién recibió qué beneficio, cuándo, por qué canal y quién del staff lo
-- otorgó", la evidencia misma del criterio de aceptación). Un huésped puede canjear el
-- mismo tipo de beneficio varias veces a lo largo de su relación con el hotel (varias
-- estancias, varias visitas al restaurante) -- no hay unique constraint por diseño.
create table public.hotel_loyalty_benefit_redemption (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  benefit_type text not null check (benefit_type in ('late_checkout', 'credito_fnb', 'reconocimiento')),
  -- Snapshot del valor configurado AL MOMENTO del canje (mismo criterio que
  -- `hotel_channel_commission_pct` congelado en la reserva, 0013): si el hotel cambia
  -- las horas de late checkout o el monto de crédito F&B después, los canjes pasados
  -- no deben "cambiar de valor" retroactivamente en el historial.
  late_checkout_hours smallint,
  fnb_credit_amount numeric(10, 2),
  reconocimiento_texto text,
  -- Canal desde el que el staff gestionó el canje (REQ-CRM-008: "gestionado desde
  -- CRM/WhatsApp") -- 'whatsapp' cuando el staff lo otorga respondiendo dentro de la
  -- bandeja de conversación del huésped (routes/mensajeria.ts), 'crm' desde el panel
  -- de huésped normal. Mismo dato, dos superficies de entrada a la MISMA API.
  canal text not null check (canal in ('crm', 'whatsapp')),
  redeemed_by uuid references public.staff_user(id) on delete set null,
  redeemed_at timestamptz not null default now()
);
-- FK compuesta (mismo criterio que hotel_loyalty_member_guest_hotel_fk, 0123): un
-- canje de Hotel A nunca puede apuntar a un guest de Hotel B.
alter table public.hotel_loyalty_benefit_redemption
  add constraint hotel_loyalty_benefit_redemption_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete cascade;
create index hotel_loyalty_benefit_redemption_guest_idx
  on public.hotel_loyalty_benefit_redemption (hotel_id, guest_id, redeemed_at desc);

alter table public.hotel_loyalty_benefit_redemption enable row level security;

-- Mismo criterio de roles que hotel_loyalty_member (0123): cualquier rol que gestiona
-- huéspedes/reservas puede leer y otorgar canjes -- es atención al huésped en el
-- momento, no configuración financiera del programa.
create policy "hotel_loyalty_benefit_redemption_tenant_select" on public.hotel_loyalty_benefit_redemption for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_loyalty_benefit_redemption_tenant_insert" on public.hotel_loyalty_benefit_redemption for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

grant select, insert on public.hotel_loyalty_benefit_redemption to authenticated;
