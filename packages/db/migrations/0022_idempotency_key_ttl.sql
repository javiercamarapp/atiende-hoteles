-- auditoria-1/datos [MEDIO] "idempotency_key no tiene TTL ni columna de expiracion"
-- (docs/auditoria-1/datos.md). La tabla (0009) crecia una fila por cada Idempotency-Key
-- recibido, PARA SIEMPRE -- sin `expires_at` ni ventana de proteccion contra reintento
-- documentada: un `Idempotency-Key` reutilizado por error meses despues devolveria
-- indefinidamente la respuesta cacheada de la primera vez.
--
-- Arreglo: columna `expires_at` (7 dias desde la creacion -- ventana generosa para
-- cubrir un reintento manual/de integracion externa real, sin ser "para siempre") mas
-- un indice de apoyo para una futura tarea de purga por lote
-- (`delete from idempotency_key where expires_at < now()`, aun no construida como job
-- programado -- documentado como el siguiente paso, no simulado aqui). El uso real de
-- la ventana (permitir reclamar de nuevo una llave ya expirada) se implementa en
-- `apps/api/src/lib/idempotency.ts` via `ON CONFLICT ... DO UPDATE ... WHERE
-- expires_at < now()`.
alter table public.idempotency_key
  add column expires_at timestamptz not null default (now() + interval '7 days');

create index idempotency_key_expires_at_idx on public.idempotency_key (expires_at);
