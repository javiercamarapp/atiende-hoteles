-- auditoria-1/datos [MEDIO] "ninguna tabla del dominio hotelero registra la zona
-- horaria del hotel -- ambiguedad entre date (sin huso) y timestamptz (UTC)"
-- (docs/auditoria-1/datos.md). `location`/`hotel` no tenian ninguna columna de zona
-- horaria: no hay donde anclar "que dia es hoy para este hotel" cuando se construya
-- night audit / reportes diarios / corte de disponibilidad (H5/H10). Hoy ningun codigo
-- depende de esto todavia -- se agrega la columna como cimiento correcto para cuando
-- ese codigo se escriba, sin inventar logica que no existe aun.
--
-- Nombre de zona horaria de la base de datos de IANA (tz database, ej.
-- 'America/Mexico_City'), no un offset fijo -- sobrevive cambios de horario de verano
-- si alguna region del despliegue los tuviera. Default al huso mas comun del mercado
-- inicial (documentado, no adivinado) -- una fila real de `hotel` puede sobreescribirlo.
alter table public.hotel add column timezone text not null default 'America/Mexico_City';

-- Validacion basica de forma (no exhaustiva: Postgres no expone una lista de zonas
-- validas como CHECK sin PL/pgSQL) -- exige "Continente/Ciudad" para descartar valores
-- claramente mal formados (ej. un offset num rico o una cadena vacia) sin acoplarse a
-- una lista de zonas que se desactualizaria.
alter table public.hotel
  add constraint hotel_timezone_formato_iana check (timezone ~ '^[A-Za-z_]+/[A-Za-z_/]+$');
