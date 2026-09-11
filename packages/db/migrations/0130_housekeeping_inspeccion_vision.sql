-- REQ-HK-003 (BP-075, BP-101, H07-016, H11-004): inspeccion de habitaciones asistida
-- por vision con el set estandar de 6 fotos, veredicto (aprobada/correccion especifica)
-- en <30 s, muestreo de supervision fisica 20-30%, decision final SIEMPRE humana. Ver
-- alcance real documentado en `packages/domain-hotel/src/housekeeping/inspeccionVision.ts`
-- -- estas columnas guardan la SUGERENCIA que produce ese modulo puro, nunca un cierre.
--
-- Expand-only sobre `housekeeping_task` (0041), sin tabla nueva: la sugerencia de vision
-- es un evento que ocurre UNA vez por tarea (tras terminar la limpieza, antes de que un
-- supervisor la inspeccione con `POST .../inspeccionar`), asi que vive como columnas de
-- la MISMA fila cuyo ciclo de vida ya gobierna 0041 -- una tabla aparte solo para esto
-- forzaria un join que ningun endpoint necesita, sin ganar nada (a diferencia de
-- `conversation_audit_sample`, 0124, que SI necesita tabla propia porque una semana
-- audita VARIAS conversaciones distintas; aqui es 1:1 con la tarea).
--
-- Reutiliza la columna `evidence` (jsonb, ya existe desde 0041, nunca escrita hasta
-- ahora) para el set de 6 fotos enviado -- exactamente el uso para el que fue nombrada,
-- documentado aqui por primera vez.
create type public.housekeeping_vision_verdict as enum ('aprobada', 'correccion');

alter table public.housekeeping_task
  add column vision_verdict public.housekeeping_vision_verdict,
  add column vision_items jsonb not null default '[]'::jsonb,
  add column vision_evaluated_at timestamptz,
  add column vision_elapsed_ms integer,
  -- BP-101: 20-30% de las inspecciones exige supervision FISICA ademas de la evidencia
  -- fotografica -- decidido determinsticamente por `requiresPhysicalSupervision(taskId)`
  -- en el momento en que se evalua la vision (no antes: depende del id real de la
  -- tarea, que ya existe para entonces). Default false para las 0041 filas historicas
  -- (creadas antes de este REQ) que nunca pasaran por este flujo.
  add column requires_physical_supervision boolean not null default false;

-- Coherencia: o los 3 campos de vision estan vacios (nunca evaluada), o los 3 estan
-- presentes juntos (evaluada una vez) -- mismo criterio de coherencia por CHECK que
-- `conversation_audit_sample_reviewed_coherente` (0124) y
-- `guest_ticket_closed_at_coherente` (0098). `vision_items` no entra al CHECK: una
-- inspeccion "aprobada" legitimamente tiene `vision_items = '[]'`.
alter table public.housekeeping_task
  add constraint housekeeping_task_vision_coherente check (
    (vision_verdict is null and vision_evaluated_at is null and vision_elapsed_ms is null)
    or (vision_verdict is not null and vision_evaluated_at is not null and vision_elapsed_ms is not null)
  ),
  -- <30 s medido (REQ-HK-003 literal) -- si algun dia una implementacion futura violara
  -- el SLA, falla la escritura en vez de persistir en silencio un dato que contradice el
  -- criterio de aceptacion.
  add constraint housekeeping_task_vision_elapsed_sla check (vision_elapsed_ms is null or vision_elapsed_ms < 30000);

-- Cola operativa: tareas terminadas con veredicto de vision pendiente de decision
-- humana (parcial, mismo criterio que `housekeeping_task_assigned_idx`, 0041 -- solo
-- indexa lo que el panel de supervision necesita escanear seguido).
create index housekeeping_task_vision_pending_idx
  on public.housekeeping_task (hotel_id, vision_evaluated_at)
  where vision_verdict is not null and inspected_at is null;

-- No se agregan politicas RLS nuevas: estas columnas viven en la MISMA fila que 0041 ya
-- protege (housekeeping ve/edita solo su propia tarea asignada; owner/gm/frontdesk ven y
-- administran todas las del hotel) -- ninguna de las 4 politicas existentes distingue
-- por columna, asi que ya cubren estas.
