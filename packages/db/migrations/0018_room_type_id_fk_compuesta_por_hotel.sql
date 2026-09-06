-- auditoria-1/datos [CRITICO] "availability/reservation/room/rate_plan.room_type_id no
-- esta scoped a hotel_id: fuga de tarifa y nombre de habitacion entre tenants distintos"
-- (docs/auditoria-1/datos.md). `room_type_id` en estas cuatro tablas era una FK SIMPLE a
-- `room_type(id)` -- nunca se verificaba que perteneciera al MISMO `hotel_id` de la fila
-- que lo referencia. Verificado con una sesion RLS real (rol `reservations`): la policy
-- de INSERT de `availability` solo exige `tenant_id`/`has_hotel_role(hotel_id, ...)`,
-- nunca que `room_type_id` pertenezca a ese `hotel_id` -- permite insertar una
-- `availability`/`reservation` de Hotel A que en realidad apunta al `room_type` (nombre
-- y tarifa) de un hotel B completamente ajeno, filtrando esa informacion via los JOIN
-- normales de `apps/api/src/routes/reservas.ts`.
--
-- Arreglo: FK COMPUESTA `(hotel_id, room_type_id) references room_type(hotel_id, id)`
-- en las 4 tablas -- Postgres exige un UNIQUE/PK sobre las columnas referenciadas del
-- padre, por eso se agrega primero `room_type(hotel_id, id)` (trivialmente unica: `id`
-- ya es PK). Esto hace que la invariante "room_type_id debe pertenecer al mismo
-- hotel_id de la fila" quede impuesta por el ESQUEMA, no solo por la aplicacion o por
-- RLS -- ninguna sesion (ni siquiera el cliente admin/superusuario) puede insertar una
-- combinacion cruzada, sin importar que rol tenga o si RLS esta activa.
--
-- Se conserva la FK simple original de cada tabla (mismo ON DELETE que ya tenian) y se
-- agrega la compuesta con el MISMO ON DELETE para no introducir un orden de disparo
-- ambiguo entre dos constraints que discreparan en la accion de borrado.
alter table public.room_type
  add constraint room_type_hotel_id_id_key unique (hotel_id, id);

alter table public.room
  add constraint room_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete restrict;

alter table public.rate_plan
  add constraint rate_plan_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete cascade;

alter table public.availability
  add constraint availability_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete cascade;

alter table public.reservation
  add constraint reservation_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete restrict;

-- Indices de apoyo para las nuevas FKs compuestas (Postgres no los crea automaticamente
-- para el lado "hijo" de una FK, solo exige el unique del lado "padre" ya agregado
-- arriba) -- evita un seq scan al validar/cascada sobre estas tablas a escala.
create index room_hotel_room_type_idx on public.room (hotel_id, room_type_id);
create index rate_plan_hotel_room_type_idx on public.rate_plan (hotel_id, room_type_id);
create index availability_hotel_room_type_idx on public.availability (hotel_id, room_type_id);
create index reservation_hotel_room_type_idx on public.reservation (hotel_id, room_type_id);
