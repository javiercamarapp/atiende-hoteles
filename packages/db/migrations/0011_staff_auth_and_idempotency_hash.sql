-- H2 · ADR-004: login por email/contraseña contra `staff_user` necesita un hash de
-- contraseña que H1 no incluyó (expand-only: se agrega aquí, nunca se edita 0003).
-- `password_hash` es NULLABLE a propósito: un `staff_user` sin contraseña todavía
-- (alta pendiente) simplemente no puede iniciar sesión, no rompe el esquema.
--
-- Se revoca el SELECT de fila completa que 0010 otorgó sobre `staff_user` y se
-- vuelve a otorgar por columnas explícitas SIN `password_hash`: ningún compañero de
-- hotel (ni siquiera vía la política "self_or_colleague" de 0003) debe poder leer el
-- hash de otro usuario a través de la API con el rol `authenticated`. El login en sí
-- lee `password_hash` con el cliente admin (superusuario, bypassa RLS y grants de
-- columna) antes de que exista una sesión autenticada -- mismo patrón que el rol de
-- servicio de GoTrue en Supabase real.
alter table public.staff_user add column password_hash text;

revoke select on public.staff_user from authenticated;
grant select (id, email, full_name, created_at, updated_at) on public.staff_user to authenticated;

-- H2 · ADR-004: idempotencia por `(tenant_id, scope, key)` ya existía (0009); falta
-- guardar el hash del cuerpo de la solicitud para poder distinguir "misma clave,
-- mismo cuerpo" (devolver la respuesta cacheada) de "misma clave, cuerpo distinto"
-- (422, ver apps/api). `request_hash` es NULLABLE porque las filas insertadas por
-- H1 antes de esta migración (si las hubiera) no tienen ese dato -- no se puede
-- rellenar retroactivamente sin inventar un hash falso.
alter table public.idempotency_key add column request_hash text;

-- 0009 solo otorgó SELECT/INSERT sobre idempotency_key: el patrón real de apps/api
-- (INSERT de reclamo ANTES de correr la mutación, luego UPDATE con la respuesta ya
-- resuelta DENTRO de la misma transacción, ver apps/api/src/lib/idempotency.ts) también
-- necesita UPDATE. No hay policy de UPDATE que lo permita todavía: se agrega aquí, con el
-- mismo alcance por tenant que ya usan sus policies de SELECT/INSERT.
grant update on public.idempotency_key to authenticated;
create policy "idempotency_key_tenant_update" on public.idempotency_key for update to authenticated
  using (tenant_id = any (current_tenant_ids()))
  with check (tenant_id = any (current_tenant_ids()));
