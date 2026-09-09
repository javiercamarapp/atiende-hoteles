-- ORIGEN: packages/db/migrations/0094_email_outbox.sql sha256:c161f8ce18866365d839ab739e350c7fe1c549aea1df74838b1a37101b1f80f6
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12a · packages/email: registro persistente de CADA intento de envío de correo
-- transaccional, sin importar el adaptador real (`FakeEmailAdapter` en dev/test,
-- `ResendAdapter`/`SmtpAdapter` pendientes de credenciales, ver packages/email/README.md).
-- Sirve tres propósitos: (1) `FakeEmailAdapter` usa esta tabla como su "bandeja" para que
-- las pruebas de integración/E2E puedan leer el correo que "se habría enviado" (nunca se
-- llama a un proveedor real sin credenciales); (2) auditoría honesta de qué se intentó
-- enviar a quién y si falló ("no_configurado" cuando no hay credenciales, nunca se finge
-- un envío exitoso); (3) idempotencia de disparadores por outbox (`dedupe_key`, evita
-- reenviar el mismo correo si un handler de `public.outbox` se reintenta).
--
-- `tenant_id`/`hotel_id` son NULLABLE a propósito: el correo de verificación de una
-- alta autoserviativa (POST /registro) se envía ANTES de que exista una fila de
-- `org`/`hotel` confirmada en algunos pasos intermedios, y el correo de prospección
-- comercial (REQ-LAUNCH) no pertenece a ningún hotel todavía.

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.org(id) on delete set null,
  hotel_id uuid references public.hotel(id) on delete set null,
  template text not null,
  to_email text not null,
  to_name text,
  subject text not null,
  preheader text not null default '',
  html text not null,
  text_body text not null,
  -- Clave de deduplicación opcional (p. ej. `reservation.confirmed:<reservationId>`)
  -- para que un handler de outbox reintentado no duplique el correo ya encolado/enviado.
  dedupe_key text,
  status text not null default 'pendiente' check (status in ('pendiente', 'enviado', 'no_configurado', 'fallido')),
  provider text not null default 'fake',
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_outbox_tenant_hotel_idx on public.email_outbox (tenant_id, hotel_id, created_at);
create index email_outbox_to_email_idx on public.email_outbox (to_email, created_at);
create unique index email_outbox_dedupe_key_idx on public.email_outbox (dedupe_key) where dedupe_key is not null;

alter table public.email_outbox enable row level security;
-- Solo owner/gm de un hotel pueden ver el correo enviado A SU HOTEL (soporte/auditoría);
-- filas con `hotel_id is null` (correo de plataforma: verificación de alta, prospección)
-- nunca son visibles vía `authenticated` -- solo el proceso backend (cliente admin) las
-- escribe y las lee (p. ej. `npm run email:preview`, fixtures de prueba).
create policy "email_outbox_hotel_admin_select" on public.email_outbox for select to authenticated
  using (
    hotel_id is not null
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
grant select on public.email_outbox to authenticated;
-- Sin policy de insert/update/delete para `authenticated`: todo envío lo hace el
-- backend (`FakeEmailAdapter`/adaptadores reales) con el cliente admin.
