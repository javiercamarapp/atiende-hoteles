-- ORIGEN: packages/db/migrations/0144_reservation_origin_actor.sql sha256:b4d40eb77227ca527a8417984b88c4d3331e3aaf517e07e40e8131ef7980e212
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H06-016/BP-169 · REQ-OBS-008: "el sistema debe instrumentar y reportar el % de
-- room-nights generadas directamente por agentes de IA como métrica de producto" (KPI
-- de la tesis agéntica del negocio, BP-169: "room-nights directas generadas por el
-- agente"). Esto es una dimensión DISTINTA de `reservation.channel` (migración 0014,
-- REQ-RES-020): `channel` responde "¿por qué INTERMEDIARIO de distribución entró esta
-- reserva? (directo/OTA/agente de IA EXTERNO que reserva a nombre del huésped, como un
-- channel manager)". Esta columna responde una pregunta distinta: "¿qué ACTOR, dentro
-- del propio flujo de este producto, creó la reserva? (el panel operado por staff
-- humano, o la conversación con el agente de IA propio del hotel)". Una reserva puede
-- ser 'directo' en canal Y 'manual' en actor (staff la tecleó en el panel) -- son ejes
-- ortogonales, por eso no se reutiliza `channel` para esto ni se agrega un valor de
-- `channel` que confundiría "intermediario externo" con "actor interno".
--
-- Import HONESTO, mismo patrón que 0014: HOY el único endpoint que crea reservas
-- (`POST /hoteles/:hotelId/reservas`, apps/api/src/routes/reservas.ts) exige sesión de
-- staff autenticado vía `requireHotelMembership` -- ningún flujo conversacional
-- (WhatsApp/voz) crea reservas de forma autónoma todavía en este repo (esa capacidad
-- es un REQ-AGT/REQ-RES futuro, no construido aquí). Por eso el DEFAULT y el ÚNICO
-- valor que cualquier escritor de este repo produce hoy es 'manual' -- la columna deja
-- el esquema y el reporte listos para el día en que un flujo agéntico de reserva
-- directa exista y escriba 'agente_ia', sin necesitar otra migración ese día. El
-- CHECK fija el vocabulario a solo estos dos valores a propósito (fail-closed: un
-- tercer valor inventado por error de escritura no debe colarse silenciosamente en un
-- KPI de negocio que el fundador va a leer).
alter table public.reservation add column origin_actor text not null default 'manual';
alter table public.reservation add constraint reservation_origin_actor_check
  check (origin_actor in ('manual', 'agente_ia'));
