-- auditoria-1/backend [ALTO] "el worker de outbox descarta la causa real del error y no
-- aplica timeout por handler" (docs/auditoria-1/backend.md). El `catch {}` de
-- `drainOutboxOnce()` (apps/api/src/outbox/worker.ts) no nombraba la variable de error
-- ni la persistia en ningun lado -- tras `maxAttempts` fallos, la fila quedaba
-- `status='fallido'` sin ninguna pista de POR QUE. Se agrega una columna para que la
-- causa real (mensaje del error, o "handler_timeout: ..." si el handler se colgo)
-- quede junto al evento, consultable por el equipo de operacion sin depender de logs
-- externos que puedan haber rotado.
alter table public.outbox add column last_error text;
