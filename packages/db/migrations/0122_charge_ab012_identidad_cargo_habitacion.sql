-- REQ-AB-012 (P1/NF): "...y verificar identidad doblemente al cargar a habitación."
-- Expand-only sobre 0007/0030 (REQ-GOB-011): ninguna migración ya aplicada se edita.
--
-- Defensa en dos capas (mismo principio que 0084_fnb_order.sql para REQ-AB-004):
-- `packages/domain-hotel/src/roomChargeIdentityGuard.ts` (`assertRoomChargeIdentityVerified`)
-- es la primera barrera (aplicación, `apps/api/src/routes/folios.ts` y
-- `apps/api/src/routes/fnbOfflineQueue.ts`); el CHECK `charge_ab_requiere_identidad_verificada`
-- de abajo es la barrera ESTRUCTURAL real -- ninguna fila de concepto 'ab' (F&B) puede
-- persistir sin evidencia de verificación de identidad, sin importar qué código
-- (incluido un bug futuro que se salte la guarda de aplicación) intente el INSERT.
--
-- No existe en este esquema una tabla de asignación real de habitación física a una
-- reserva (esa asignación vive en el PMS externo -- REQ-AB-002/013, pendiente de
-- credenciales). Por eso la verificación NO compara "número de habitación": compara
-- DOS reclamos de identidad independientes contra el huésped en archivo de la reserva
-- del folio (`guest.full_name` / `guest.phone`, ya capturados desde 0005_guest.sql) --
-- ver el comentario de módulo de `roomChargeIdentityGuard.ts` para el razonamiento
-- completo, incluida la política fail-closed de cuándo SÍ existe una válvula de
-- escape administrativa y cuándo NUNCA la hay (una discrepancia activa jamás es
-- overridable por esta vía).

alter table public.charge add column identity_verified_at timestamptz;
alter table public.charge add column identity_verified_by uuid references public.staff_user(id) on delete set null;
alter table public.charge add column identity_verification_surname_stated text;
alter table public.charge add column identity_verification_phone_last4_stated text
  check (identity_verification_phone_last4_stated is null or identity_verification_phone_last4_stated ~ '^[0-9]{4}$');
-- Set SOLO cuando la verificación se concedió por la válvula de escape administrativa
-- (sin huésped/sin teléfono en archivo) -- nunca cuando un reclamo activo coincidió, y
-- nunca cuando un reclamo activo NO coincidió (ese caso no tiene válvula de escape).
alter table public.charge add column identity_verification_override_by uuid references public.staff_user(id) on delete set null;

alter table public.charge add constraint charge_identity_verified_pair_check
  check ((identity_verified_at is null) = (identity_verified_by is null));

-- El apellido declarado siempre se registra cuando hubo verificación (evidencia
-- auditable del reclamo, con o sin válvula de escape administrativa).
alter table public.charge add constraint charge_identity_verified_evidence_check
  check (identity_verified_at is null or identity_verification_surname_stated is not null);

-- Toda verificación exitosa dejó UNA de dos evidencias: el teléfono declarado (calzó
-- contra el archivo) o la autorización administrativa (dato no disponible para
-- comparar) -- nunca ninguna de las dos, nunca ambas a la vez (serían contradictorias:
-- si el teléfono calzó, no hizo falta autorización).
alter table public.charge add constraint charge_identity_verified_trail_check
  check (
    identity_verified_at is null
    or (identity_verification_phone_last4_stated is not null) <> (identity_verification_override_by is not null)
  );

-- La barrera estructural real de REQ-AB-012: todo cargo de concepto 'ab' (F&B) exige
-- verificación de identidad registrada. Los demás conceptos (hospedaje/extras/ajuste/
-- propina/descuento/reverso/otro) no pasan por este control -- ni el night audit
-- (siempre 'hospedaje', sin huésped presente en el momento de postear) ni una
-- penalización de no-show (`apps/api/src/jobs/noShow.ts`, también 'hospedaje') tienen
-- un huésped frente al staff para verificar.
alter table public.charge add constraint charge_ab_requiere_identidad_verificada
  check (concept <> 'ab' or identity_verified_at is not null);

comment on column public.charge.identity_verified_at is
  'REQ-AB-012: momento en que se verificó identidad doblemente antes de postear un cargo de A&B a habitación. NULL para cualquier concepto distinto de ''ab''.';
