-- H4 · REQ-RES-020: registrar por reserva el canal/agente de origen para atribución de
-- comisión y reporting de room-nights directas. REQ-RES-022/REQ-REV-008 prohíben
-- construir conectividad OTA propia en esta fase, así que ningún escritor de este
-- repositorio produce hoy un valor distinto de 'directo' -- la columna deja el esquema
-- listo para cuando exista un channel manager/PMS certificado, sin otra migración.
alter table public.reservation add column channel text not null default 'directo';
