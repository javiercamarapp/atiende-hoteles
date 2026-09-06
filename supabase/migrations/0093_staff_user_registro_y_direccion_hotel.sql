-- ORIGEN: packages/db/migrations/0093_staff_user_registro_y_direccion_hotel.sql sha256:90e8565a21f0acff8d82d0b1bdb1bc860e414dea12d6ab7472cddd203c11f8f3
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12a · Alta autoservicio (POST /registro, REQ-LAUNCH): una cuenta nueva por
-- correo+contraseña exige verificación de correo ANTES de poder iniciar sesión
-- (`email_verified_at is not null`); una cuenta creada vía Google llega ya verificada
-- (Google ya confirmó `email_verified` en el id_token, ver apps/api/src/routes/
-- auth-google.ts) -- por eso la columna es un timestamp nullable, no un booleano: sirve
-- también de evidencia de CUÁNDO se verificó (auditoría). `created_via` es solo
-- informativo (nunca cambia autorización) para poder distinguir en soporte/auditoría
-- una cuenta de autoservicio de una sembrada a mano o invitada.
alter table public.staff_user add column email_verified_at timestamptz;
alter table public.staff_user add column created_via text not null default 'seed'
  check (created_via in ('seed', 'registro_autoservicio', 'invitacion', 'google'));

-- Ciudad/estado del hotel (REQ-LAUNCH): capturados en el formulario de /registro para
-- poder fijar `hotel_tax_config.state_code` (ISH varía por estado, migración 0030) sin
-- adivinarlo -- `location` no tenía ninguna columna de domicilio hasta ahora.
alter table public.location add column city text;
alter table public.location add column state_name text;
