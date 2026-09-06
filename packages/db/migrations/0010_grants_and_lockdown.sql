-- H1 · Cierre de permisos (ADR-004): rol de aplicacion sin BYPASSRLS, REVOKE ALL FROM
-- PUBLIC ya aplicado a nivel de esquema (0001); aqui se hace explicito tabla por tabla
-- (defensa en profundidad, no depende solo del default de Postgres 15+) y se otorgan los
-- privilegios minimos que cada politica RLS ya definida necesita para poder aplicarse
-- (GRANT + RLS son independientes: sin el GRANT, la politica nunca llega a evaluarse).

revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;
revoke all on all functions in schema auth from public;

-- Confirma que `atiende_app` (rol de LOGIN del pool del backend) nunca tiene BYPASSRLS ni
-- superusuario, incluso si alguna migracion futura lo intentara: no es reversible por una
-- migracion posterior (ver README de packages/db).
alter role atiende_app nosuperuser nobypassrls;

-- Catalogo de tenant/org (solo lectura para `authenticated`; alta de org/hotel es
-- operacion de plataforma fuera de alcance de H1, se hace con el rol propietario).
grant select on public.org to authenticated;
grant select on public.location to authenticated;
grant select on public.hotel to authenticated;
grant select on public.staff_user to authenticated;
grant select, insert, update, delete on public.hotel_staff to authenticated;

-- Inventario y tarifas.
grant select, insert, update, delete on public.room_type to authenticated;
grant select, insert, update, delete on public.room to authenticated;
grant select, insert, update, delete on public.rate_plan to authenticated;
grant select, insert, update, delete on public.availability to authenticated;

-- El `revoke all on all functions in schema public from public` de arriba tambien quita
-- el EXECUTE (concedido por defecto a PUBLIC en Postgres) de las funciones creadas en
-- 0004 que no re-otorgaron su propio grant explicito; se restituye aqui.
grant execute on function public.lock_availability(uuid, uuid, date) to atiende_app, authenticated;
grant execute on function public.book_availability(uuid, uuid, date, integer) to atiende_app, authenticated;

-- Huespedes y reservas.
grant select, insert, update, delete on public.guest to authenticated;
grant select, insert, update, delete on public.reservation to authenticated;
grant select on public.reservation_status_event to authenticated;
grant select on public.reservation_status_transition to authenticated;

-- Dinero: folio/charge/payment nunca se editan/borran salvo folio (abrir/cerrar); charge
-- y payment son append-only (reverso via `charge.reversed_by`, REQ-REC-004).
grant select, insert, update on public.folio to authenticated;
grant select, insert on public.charge to authenticated;
grant select, insert on public.payment to authenticated;

-- audit_log: append-only, solo lectura directa; toda escritura pasa por
-- record_audit_log() (SECURITY DEFINER, ver 0008).
grant select on public.audit_log to authenticated;

-- Outbox / idempotencia (operativas del backend).
grant select, insert, update on public.outbox to authenticated;
grant select, insert on public.idempotency_key to authenticated;

-- `atiende_app` en si (antes de `set local role authenticated`) solo necesita poder
-- conmutar de rol; no recibe privilegios de tabla propios.
