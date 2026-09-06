-- auditoria-2/frontend [ALTO]: `maintenance_ticket.estimated_cost` era
-- `not null default 0` (0043_maintenance_ticket.sql) -- sin ningún campo en el
-- formulario de "Reportar" para capturarlo, TODO ticket nuevo quedaba en 0, y
-- Mantenimiento.tsx renderizaba "Estimado: $0.00 MXN" sin condición: un costo que
-- nadie estimó se veía como una medición real de $0 (viola REQ-UX-002, "nunca simular
-- una cifra"). Se vuelve la columna NULLABLE (mismo patrón que `actual_cost`, ya
-- nullable en la misma tabla) para que el backend pueda distinguir honestamente
-- "sin estimar" (NULL) de "se estimó en cero" (0) -- expand-only, no destructivo: las
-- filas existentes conservan su valor 0 tal cual.
alter table public.maintenance_ticket alter column estimated_cost drop not null;
alter table public.maintenance_ticket alter column estimated_cost drop default;
