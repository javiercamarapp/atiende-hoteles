-- A5 (auditoria-2 agentico ALTO, REQ-AGT-020): el techo de costo mensual por
-- (hotel, agente) se comprobaba con una lectura no bloqueante (`agent_cost_mes()`,
-- SELECT agregado) -- dos ejecuciones casi simultáneas del mismo agente/hotel podían
-- ambas leer "restante > 0" ANTES de que cualquiera insertara su propia fila en
-- `agent_run`, y juntas rebasar el techo configurado (cada una gastando hasta su
-- propio remanente, sin saber cuánto gastaba la otra).
--
-- Mismo patrón ya usado en este código para el mismo problema en otras dos capas
-- (`lock_agent_approval_key`, 0042; `night_audit_claim`, 0031): un advisory lock
-- TRANSACCIONAL serializa las corridas concurrentes del mismo (hotel, agente) -- la
-- segunda espera a que la primera COMITEE (con su costo real ya en `agent_run`) antes
-- de leer `agent_cost_mes()`, así que ve el consumo real actualizado en vez de un
-- valor obsoleto.
create or replace function public.lock_agent_budget(_hotel_id uuid, _agent_name text)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(_hotel_id::text || ':agent_budget:' || _agent_name, 0));
end;
$$;

revoke all on function public.lock_agent_budget(uuid, text) from public;
grant execute on function public.lock_agent_budget(uuid, text) to atiende_app, authenticated;
