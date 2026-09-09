-- ORIGEN: packages/db/migrations/0125_room_type_cloudbeds_external_id.sql sha256:46fd87694cb9a39b819f39deab529be79c798fadaeda8799a8c49d23869ec7be
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H15-001/ADR-007 (`@atiende-hoteles/mcp-pms`): primer punto real de integracion desde
-- apps/api hacia el conector Cloudbeds -- ver
-- `apps/api/src/jobs/pmsCloudbedsSyncScheduler.ts`. Ese planificador sincroniza tarifas
-- (`PmsPort.listRatePlans`) hacia `public.rate_plan` para cada `room_type` que declare
-- su equivalente en Cloudbeds; sin esa columna no hay forma de saber a que `roomTypeID`
-- de Cloudbeds corresponde un `room_type` propio. Mismo criterio que `external_id` de
-- `guest_review` (migracion 0097): columna nullable, lista para cuando exista la
-- integracion real, sin asumir que YA esta conectada (hoy sigue "[PENDIENTE DE
-- CREDENCIALES]", ver README de `packages/mcp-servers/pms`).
--
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migracion ya aplicada
-- se edita.
alter table public.room_type add column cloudbeds_room_type_id text;

-- Un mismo roomTypeID de Cloudbeds no puede mapear a dos room_type distintos del MISMO
-- hotel (evita que el scheduler escriba la misma tarifa sincronizada dos veces bajo dos
-- filas locales distintas). Parcial: sin valor, no participa en el índice.
create unique index room_type_cloudbeds_room_type_id_idx
  on public.room_type (hotel_id, cloudbeds_room_type_id)
  where cloudbeds_room_type_id is not null;
