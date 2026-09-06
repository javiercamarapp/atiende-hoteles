-- auditoria-2/seguridad [CRITICO]: "sat_filing_approval no valida que su
-- hotel_id/tenant_id correspondan a la fiscal_obligation que aprueba: la aprobacion
-- humana exigida por e.firma se puede forjar desde cualquier hotel". Escenario real
-- (ADR-004, multi-propiedad): un `owner` de Hotel C (sin relacion con Hotel B) inserta
-- una fila de `sat_filing_approval` con `hotel_id=HotelC` (pasa su propia policy de
-- INSERT, que solo mira el `hotel_id` que la fila declara) pero `obligation_id`
-- apuntando a una obligacion REAL de Hotel B; si esa misma persona tiene tambien rol de
-- `accountant` en Hotel B, el trigger `fiscal_obligation_requires_approval` (0033) solo
-- comprueba EXISTENCIA de alguna fila para ese `obligation_id`, sin comparar su
-- hotel_id/tenant_id -- la presentacion de Hotel B queda marcada 'presentada' sin que
-- ningun owner/gm de Hotel B la haya autorizado. (auditoria-2/datos evaluo el mismo
-- vector con actores DISTINTOS sin membresia cruzada y lo encontro inofensivo porque el
-- trigger no es SECURITY DEFINER -- pero la RLS de seleccion de `sat_filing_approval`
-- se evalua contra TODA la membresia del actor, no contra "el hotel que esta operando
-- ahora", asi que un actor con doble membresia real (Hotel B + Hotel C) SI ve su propia
-- fila fabricada de Hotel C al evaluar el trigger desde su sesion de Hotel B.)
--
-- Arreglo: mismo patron que 0018/0060/0061 -- FK COMPUESTA
-- (hotel_id, obligation_id) references fiscal_obligation(hotel_id, id), impuesta por
-- el ESQUEMA. Con esto, `sat_filing_approval.hotel_id` SIEMPRE debe coincidir con el
-- `hotel_id` real de la obligacion que aprueba -- el INSERT cruzado de arriba ahora es
-- estructuralmente imposible (no existe ninguna fiscal_obligation con
-- hotel_id=HotelC e id=<obligacion de Hotel B>), sin depender de que el trigger de
-- defensa en profundidad sea o deje de ser SECURITY DEFINER en el futuro.
alter table public.fiscal_obligation
  add constraint fiscal_obligation_hotel_id_id_key unique (hotel_id, id);

alter table public.sat_filing_approval
  add constraint sat_filing_approval_obligation_hotel_fk
  foreign key (hotel_id, obligation_id) references public.fiscal_obligation (hotel_id, id) on delete cascade;

create index sat_filing_approval_hotel_obligation_idx on public.sat_filing_approval (hotel_id, obligation_id);
