-- ORIGEN: packages/db/migrations/0130_quote_abandonment.sql sha256:f26194b0baecada0089c81ded448a97a59231ac3688ecacdf3475d0e074cbd25
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-011: "El sistema debe detectar reservas/cotizaciones abandonadas en el motor
-- propio y contactar al huésped dentro de ventanas definidas (10 min, 2h, 24h)
-- ofreciendo ayuda o un incentivo no monetario." `public.reservation` ya nace en estado
-- `cotizada` (ADR-005, migración 0006) y solo avanza a `confirmada` cuando el huésped/
-- staff la confirma -- una cotización "abandonada" es simplemente una fila que se quedó
-- en `cotizada` más allá de una de estas 3 ventanas. Hasta esta migración no existía
-- ninguna columna para recordar qué ventana(s) ya dispararon su contacto -- sin ella,
-- cada corrida del planificador (`apps/api/src/jobs/quoteAbandonmentScheduler.ts`)
-- reenviaría el mismo contacto una y otra vez mientras la reserva siga `cotizada`.
--
-- 3 columnas independientes (una por ventana) en vez de una sola "última ventana
-- notificada": el criterio de aceptación exige "exactamente 3 contactos... ninguno antes
-- ni después" -- cada ventana debe poder marcarse y auditarse por separado, y una
-- reserva puede (legítimamente) recibir las 3 si sigue sin confirmarse 24h después.
-- Nullable, sin default distinto de NULL, mismo criterio que
-- `guest_ticket.sla_warning_notified_at` (migración 0128): "todavía no se contactó" se
-- representa como NULL, nunca como una fecha centinela.
--
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migración ya aplicada se
-- edita.
alter table public.reservation add column abandonment_contacted_10m_at timestamptz;
alter table public.reservation add column abandonment_contacted_2h_at timestamptz;
alter table public.reservation add column abandonment_contacted_24h_at timestamptz;

-- Escaneo del planificador (`apps/api/src/jobs/quoteAbandonment.ts`): parcial sobre
-- reservas todavía `cotizada` que le falta AL MENOS una de las 3 ventanas -- mismo
-- criterio que `guest_ticket_sla_warning_pending_idx` (0128), para no reescanear en cada
-- tick las reservas que ya recibieron sus 3 contactos o que ya avanzaron de estado.
create index reservation_abandonment_pending_idx on public.reservation (hotel_id, created_at)
  where status = 'cotizada'
    and (abandonment_contacted_10m_at is null
      or abandonment_contacted_2h_at is null
      or abandonment_contacted_24h_at is null);
