-- ORIGEN: packages/db/migrations/0060_reservation_guest_id_fk_compuesta.sql sha256:1c83823663b72d93eb70eb20a89ee779f6971e15b495403d9b796df0fe4fdc19
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-2/seguridad [ALTO] + auditoria-2/datos [CRITICO, reproducido por API real]:
-- "reservation.guest_id no esta scoped a hotel_id: una reserva puede referenciar al
-- huesped de otro hotel" -- MISMA clase de defecto que D-C1 (room_type_id, cerrado en
-- 0018), nunca generalizada a `guest_id`. Reproducido con sesion RLS real (gm de un
-- hotel, sin rol en un segundo hotel del seed): `POST /hoteles/:hotelId/reservas` con
-- `guestId` de un guest ajeno respondia 201 y la fila quedaba con
-- `hotel_id=hotelPropio, guest_id=<guest de otro hotel>` -- ni la policy de INSERT de
-- `reservation` (solo mira tenant_id/hotel_id/rol del actor) ni ninguna FK lo impedian.
-- Es ademas la causa raiz que habilita el CRITICO de checkin_link (0061): sin este
-- vacio, una reserva de Hotel A jamas podria resolver a un guest de Hotel B.
--
-- Arreglo: mismo patron que 0018 -- FK COMPUESTA (hotel_id, guest_id) references
-- guest(hotel_id, id), impuesta por el ESQUEMA (ninguna sesion, ni siquiera el cliente
-- admin, puede insertar la combinacion cruzada). `guest_id` sigue siendo NULLABLE
-- (MATCH SIMPLE no exige la FK cuando cualquier columna referenciante es NULL) y se
-- conserva el mismo `ON DELETE SET NULL` de la FK simple original -- pero limitado a
-- la columna `guest_id` via la sintaxis `ON DELETE SET NULL (guest_id)` (Postgres 15+,
-- este esquema corre sobre Postgres 18 via embedded-postgres) para que borrar un guest
-- NUNCA intente poner en NULL `reservation.hotel_id` (columna NOT NULL: eso haria
-- fallar el borrado en vez de solo desvincular el guest, cambiando el comportamiento
-- ya establecido).
alter table public.guest
  add constraint guest_hotel_id_id_key unique (hotel_id, id);

alter table public.reservation
  add constraint reservation_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id)
  on delete set null (guest_id);

create index reservation_hotel_guest_idx on public.reservation (hotel_id, guest_id);
