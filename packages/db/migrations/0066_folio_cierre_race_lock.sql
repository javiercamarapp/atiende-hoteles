-- auditoria-2/datos [CRITICO, reproducido 10/10 veces contra embedded-postgres real]:
-- "Un folio se puede cerrar como saldo_cero mientras un cargo nuevo entra por otra
-- peticion: la base no impide escribir charge en un folio cerrado". `POST .../cargos` y
-- `POST .../cerrar` (apps/api/src/routes/folios.ts) cada uno hace "leer estado ->
-- decidir -> escribir" en pasos separados, sin lock -- disparados en paralelo
-- (Promise.all) sobre el mismo folio recien creado en $0, las 10/10 veces ambas
-- peticiones tuvieron exito y el folio quedaba 'cerrado' con un cargo real sin cobrar
-- dentro. Ninguna policy RLS de `charge` mira `folio.status`.
--
-- Arreglo, ENTERAMENTE en la base (no se toca apps/api/src/routes/folios.ts, que
-- pertenece a otro lote de correccion en curso):
--   1. Trigger BEFORE INSERT en `charge` que toma un lock de fila real
--      (`select ... for update`) sobre el `folio` padre y rechaza el INSERT si ya esta
--      'cerrado' -- convierte la invariante de negocio ("un folio cerrado no admite
--      cargos") en una restriccion real del esquema, no solo del chequeo de aplicacion
--      que ya existia (folios.ts:239-240) pero que no tenia ningun lock detras.
--   2. Trigger BEFORE UPDATE en `folio` que, cuando la actualizacion cierra el folio
--      como 'saldo_cero', RECALCULA el saldo real (suma de charge.amount+tax_amount
--      menos payment.amount capturado, MISMA formula que
--      apps/api/src/routes/folios.ts:computeBalance) en el momento exacto en que el
--      UPDATE ya tiene el lock de fila del folio (lock implicito de todo UPDATE) y
--      rechaza el cierre si el saldo actual ya no es cero.
--
-- Por que esto cierra la carrera sin importar el orden de llegada: ambos triggers
-- comparten el MISMO recurso de lock (la fila de `folio`). Si el INSERT de charge gana
-- la carrera, el UPDATE de cierre queda bloqueado hasta que el INSERT comprometa (o
-- aborte); al desbloquearse, su trigger BEFORE UPDATE recalcula el saldo YA con el
-- cargo nuevo visible y rechaza el cierre como 'saldo_cero'. Si el UPDATE de cierre
-- gana la carrera, el INSERT de charge queda bloqueado por el `for update` del primer
-- trigger hasta que el cierre comprometa; al desbloquearse, relee `folio.status`
-- (ya 'cerrado') y rechaza el cargo. En ambos ordenes, el resultado final es
-- consistente: nunca queda un folio 'cerrado' con saldo distinto de cero por esta via.
create or replace function public.charge_reject_on_closed_folio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.folio_status;
begin
  select status into v_status from public.folio where id = new.folio_id for update;
  if not found then
    raise exception 'folio_no_encontrado: el folio % no existe (charge_reject_on_closed_folio)', new.folio_id
      using errcode = 'P0001';
  end if;

  if v_status = 'cerrado' then
    raise exception 'folio_cerrado_no_admite_cargos: el folio % esta cerrado, no admite nuevos cargos', new.folio_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger charge_reject_on_closed_folio_trg
  before insert on public.charge
  for each row execute function public.charge_reject_on_closed_folio();

create or replace function public.folio_reject_inconsistent_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_charges numeric(14, 2);
  v_total_payments numeric(14, 2);
  v_balance numeric(14, 2);
begin
  if new.status = 'cerrado' and old.status is distinct from 'cerrado' and new.close_reason = 'saldo_cero' then
    select coalesce(sum(amount + tax_amount), 0) into v_total_charges
    from public.charge where folio_id = new.id;

    select coalesce(sum(amount), 0) into v_total_payments
    from public.payment where folio_id = new.id and status = 'capturado';

    v_balance := round(v_total_charges - v_total_payments, 2);

    if abs(v_balance) > 0.01 then
      raise exception 'cierre_balance_invalido: el folio % no tiene saldo cero (saldo actual %), no puede cerrarse como saldo_cero', new.id, v_balance
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger folio_reject_inconsistent_close_trg
  before update of status on public.folio
  for each row execute function public.folio_reject_inconsistent_close();
