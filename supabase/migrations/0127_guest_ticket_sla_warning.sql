-- ORIGEN: packages/db/migrations/0127_guest_ticket_sla_warning.sql sha256:c98884b0d49fc1d2f57980abd3fe4048ee7920bba8662e0cfcd11cacf0d5d7b5
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HUE-014 (ampliación "notificación activa"): patrón ganador de competencia
-- (Duve/Optii) verificado hoy -- al 75% del SLA transcurrido se alerta al
-- asignado+supervisor SIN esperar a que el ticket venza, ANTES de la escalación al
-- 100% que ya existía (`escalated_at`/`escalated_to_roles`, migración 0098). Hasta esta
-- migración `guest_ticket` no tenía ninguna columna para recordar si ese aviso
-- temprano ya se envió -- sin ella, cada corrida del planificador (cada 5 min, ver
-- `apps/api/src/jobs/ticketEscalationScheduler.ts`) reenviaría el mismo aviso una y
-- otra vez mientras el ticket siga abierto entre el 75% y el 100% de su SLA.
--
-- Nullable, sin default distinto de NULL: mismo criterio que `escalated_at` (0098) --
-- "nunca se avisó" se representa como NULL, no como una fecha centinela. A diferencia
-- de `escalated_at`, esta columna NO participa en ningún CHECK de coherencia con
-- `status`: un ticket puede cerrarse legítimamente DESPUÉS de recibir el aviso
-- temprano (de hecho ese es el resultado deseado -- el aviso cumplió su función) o
-- incluso escalarse (aviso temprano ignorado, luego sí venció del todo); ambas
-- combinaciones de (status, sla_warning_notified_at no nulo) son válidas.
--
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migración ya aplicada
-- se edita.
alter table public.guest_ticket add column sla_warning_notified_at timestamptz;

-- Escaneo del aviso temprano (`apps/api/src/jobs/ticketEscalation.ts::notifyApproachingSlaGuestTickets`):
-- mismo criterio que `guest_ticket_open_sla_idx` (0098) -- parcial sobre tickets
-- abiertos/en progreso que TODAVÍA no recibieron el aviso, para no re-escanear en cada
-- tick los que ya lo tienen o los que ya están cerrados/cancelados/escalados.
create index guest_ticket_sla_warning_pending_idx on public.guest_ticket (hotel_id, created_at, sla_minutes)
  where status in ('abierto', 'en_progreso') and sla_warning_notified_at is null;
