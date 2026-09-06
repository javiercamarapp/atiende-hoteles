-- ORIGEN: packages/db/migrations/0053_staff_whatsapp_phone.sql sha256:97280e194c68b90976539ce3a85c5689398bdaf6a3634bb5b55441901c668155
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-UX-006 (H09-026/BP-010): "Las aprobaciones operativas del gerente (reembolso
-- sobre umbral, upgrade gratuito, compra urgente, respuesta a reseña negativa) deben
-- poder ejecutarse mediante botón directamente en el mensaje de WhatsApp, sin
-- requerir acceso al panel web." Para resolver QUIÉN aprobó desde un webhook de
-- WhatsApp (que no trae un JWT de sesión), se necesita poder mapear el número de
-- WhatsApp remitente a un `staff_user` real -- exactamente el mismo actor/rol que ya
-- usa el endpoint autenticado del panel web (apps/api/src/lib/aprobacionEjecutor.ts).
--
-- Formato E.164 (+ seguido de 8-15 dígitos) -- mismo estándar que usa
-- `SendTemplateMessageInput.to`/`SendTextMessageInput.to` en
-- packages/mcp-servers/whatsapp/src/port.ts. Nullable y único: no todo staff tiene
-- (o necesita) aprobar por WhatsApp.
alter table public.staff_user add column whatsapp_phone text;
alter table public.staff_user add constraint staff_user_whatsapp_phone_unique unique (whatsapp_phone);
alter table public.staff_user add constraint staff_user_whatsapp_phone_formato check (whatsapp_phone is null or whatsapp_phone ~ '^\+[0-9]{8,15}$');

-- Autoservicio: cada staff puede registrar/actualizar SU PROPIO número de WhatsApp
-- (apps/api/src/routes/auth.ts, PATCH /auth/me/whatsapp) -- nunca el de otro. GRANT a
-- nivel de COLUMNA (no toda la fila): `authenticated` sigue sin poder tocar
-- `email`/`full_name`/`password_hash` por este camino, incluso siendo su propia fila
-- (0010 ya solo concede SELECT sobre staff_user; esto añade UPDATE acotado a una sola
-- columna, la policy de abajo restringe además a la fila propia).
grant update (whatsapp_phone) on public.staff_user to authenticated;
create policy "staff_user_self_update_whatsapp" on public.staff_user for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
