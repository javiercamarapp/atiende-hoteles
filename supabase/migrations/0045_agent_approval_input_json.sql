-- ORIGEN: packages/db/migrations/0045_agent_approval_input_json.sql sha256:0b008a2d08e7189cb0253b1fbee475ef4ea7b3356f37782c9f33b378212acac6
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H6b · `agent_approval.input_json`: el input REAL (ya validado por Zod) que recibio la
-- tool, ademas de `input_hash`/`input_summary` (0042). Necesario para que `apps/api`
-- pueda "reproducir" la ejecucion de la tool DESPUES de que la doble confirmacion se
-- completo fuera del bucle de `AgentRunner` (p.ej. un humano decide via
-- POST /aprobaciones/:id/decidir en dos peticiones HTTP separadas, no dentro de una sola
-- corrida de agente) -- `AgentRunner.run()` no lo necesita porque conserva `parsed.data`
-- en memoria durante su propia corrida; `PostgresApprovalQueue` SI lo persiste para que
-- ese flujo fuera-de-banda sea posible. NO forma parte del contrato `ApprovalQueue`
-- (`ApprovalRequest` no gana este campo): es una extension propia de
-- `PostgresApprovalQueue.getStoredInput()`, documentada en agent-core.

alter table public.agent_approval add column input_json jsonb;
