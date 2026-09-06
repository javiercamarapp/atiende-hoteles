-- B1/auditoria-2 backend CRÍTICO: POST /hoteles/:hotelId/reservas/procesar-no-show
-- podía postear la penalización de no-show DOS veces con solo dos clics/reintento de
-- red -- el filtro `status = 'confirmada'` de runNoShowJob() solo garantiza
-- idempotencia SECUENCIAL (después de que la primera corrida ya hizo commit), no bajo
-- dos transacciones concurrentes que leen el mismo estado ANTES de que cualquiera
-- escriba. Mismo patrón que ya resuelve `charge_folio_stay_date_hospedaje_idx` (0030)
-- para el cargo de hospedaje del night audit: una restricción única en BD, última
-- línea de defensa contra la carrera, sin depender de que la aplicación gane la
-- carrera correctamente.
--
-- `no_show_reservation_id` es NULL para cualquier cargo que no sea una penalización de
-- no-show (no afecta ningún otro camino de `charge`); el índice único parcial
-- garantiza como máximo UN cargo de penalización de no-show por reserva, sin importar
-- cuántas veces se dispare el job/endpoint para esa misma reserva.
alter table public.charge add column no_show_reservation_id uuid references public.reservation(id) on delete set null;

create unique index charge_no_show_reservation_idx
  on public.charge (no_show_reservation_id)
  where no_show_reservation_id is not null;
