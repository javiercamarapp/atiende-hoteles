-- H12a · REQ-LAUNCH: onboarding guiado (`PATCH /hoteles/:hotelId/onboarding/zona-horaria`,
-- routes/registro.ts) necesita que owner/gm puedan corregir `hotel.timezone`
-- (migración 0023, agregada como cimiento sin ningún camino de escritura todavía) --
-- hasta ahora `public.hotel` solo tenía SELECT otorgado a `authenticated` (migración
-- 0010): ninguna columna era editable por el rol de aplicación.
--
-- Grant acotado a la columna `timezone` (nunca fila completa: `org_id`/`id` de `hotel`
-- deben seguir siendo inmutables desde este rol, esos solo los cambia una migración) --
-- mismo criterio de columna explícita que `staff_user`/`0053_staff_whatsapp_phone.sql`.
grant update (timezone) on public.hotel to authenticated;

create policy "hotel_owner_update_timezone" on public.hotel for update to authenticated
  using (has_hotel_role(id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(id, array['owner', 'gm']::public.hotel_role[]));
