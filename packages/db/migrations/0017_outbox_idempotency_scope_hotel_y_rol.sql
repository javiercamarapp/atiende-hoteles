-- auditoria-1/seguridad [CRITICO] "outbox e idempotency_key solo aislan por
-- organizacion, no por hotel: cualquier staff de un hotel lee y falsifica eventos de
-- otro hotel de la misma org" (docs/auditoria-1/seguridad.md).
--
-- Ambas tablas (0009) tienen columna `hotel_id` pero sus policies solo comparaban
-- `tenant_id = any(current_tenant_ids())` -- nunca `hotel_id`, y el comentario original
-- de 0009 ("restringidas a roles de gestion owner/gm") nunca se implemento: el GRANT es
-- liso para todo `authenticated`. Verificado: housekeeping de un hotel podia leer
-- (y falsificar via INSERT) el outbox/idempotency_key de OTRO hotel de la misma org,
-- incluyendo montos/metodo de pago en transito.
--
-- Arreglo: se reemplazan las policies para exigir ADEMAS `hotel_id = any
-- (current_hotel_ids())` y `can_access_money(hotel_id)` (0007) -- el mismo criterio de
-- rol que ya protege folio/charge/payment, porque el payload de estos eventos es
-- financiero (montos, metodos de pago, totales de reserva) en la misma medida. Los 4
-- roles reales que hoy escriben aqui (MANAGE_RESERVATIONS_ROLES: owner/gm/frontdesk/
-- reservations, ver apps/api/src/domain/roles.ts) son subconjunto estricto de
-- can_access_money(), asi que ningun flujo de aplicacion existente se rompe.
-- `hotel_id is null` queda sin policy que la alcance (deny-by-default): hoy ningun
-- escritor de apps/api inserta con hotel_id nulo.
drop policy "outbox_tenant_manager_select" on public.outbox;
drop policy "outbox_tenant_manager_insert" on public.outbox;
drop policy "outbox_tenant_manager_update" on public.outbox;

create policy "outbox_hotel_money_role_select" on public.outbox for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));
create policy "outbox_hotel_money_role_insert" on public.outbox for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));
create policy "outbox_hotel_money_role_update" on public.outbox for update to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id))
  with check (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));

drop policy "idempotency_key_tenant_select" on public.idempotency_key;
drop policy "idempotency_key_tenant_insert" on public.idempotency_key;
drop policy "idempotency_key_tenant_update" on public.idempotency_key;

-- `idempotency_key` no tiene columna `hotel_id` (0009): el scope (ADR-004) es por
-- `(tenant_id, scope, key)`, no por hotel -- el resto de la fuga reportada
-- ("housekeeping lee montos de un pago de otro hotel") viene de que CUALQUIER
-- `authenticated` del org podia leer/escribir, sin filtro de rol. Se cierra exigiendo
-- que el actor tenga rol de dinero en AL MENOS un hotel de ese org (equivalente al
-- criterio "gestiona dinero en la organizacion", ya que la tabla no distingue hotel).
create policy "idempotency_key_money_role_select" on public.idempotency_key for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );
create policy "idempotency_key_money_role_insert" on public.idempotency_key for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );
create policy "idempotency_key_money_role_update" on public.idempotency_key for update to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  )
  with check (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );
