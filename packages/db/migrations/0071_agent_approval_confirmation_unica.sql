-- A3/T3/backend ALTO (auditoria-2): `PostgresApprovalQueue.decide()` no tenia ningun
-- bloqueo de fila ni restriccion en BD que impidiera que un mismo actor confirmara la
-- MISMA aprobacion dos veces bajo una carrera (el codigo ya se corrige con
-- `SELECT ... FOR UPDATE` en agent-core/src/postgresApproval.ts, ver ese archivo) --
-- esta restriccion unica es la segunda linea de defensa en BD, igual que
-- `agent_approval_lookup_idx`/`lock_agent_approval_key` lo son para `request()`: un
-- actor decide UNA sola vez por aprobacion, sin importar cuantas veces se intente el
-- INSERT.
alter table public.agent_approval_confirmation
  add constraint agent_approval_confirmation_actor_unq unique (approval_id, actor);
