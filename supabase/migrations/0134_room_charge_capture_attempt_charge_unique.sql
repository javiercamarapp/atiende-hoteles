-- ORIGEN: packages/db/migrations/0134_room_charge_capture_attempt_charge_unique.sql sha256:1d8a63ed7831c96194b30212c7a0debae98bd1cd728319e4324364e7681ae028
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura de cargos ≥99.5%" (H10-020):
-- hueco de fraude real encontrado en el endpoint
-- `POST /hoteles/:hotelId/folios/:folioId/cargos-habitacion/intentos/:intentoId/capturar`
-- (apps/api/src/routes/capturaCargos.ts) -- vinculaba un intento a CUALQUIER `charge`
-- real del mismo folio sin validar que el monto coincidiera, y nada (ni la capa de
-- aplicación ni la base de datos) impedía vincular el MISMO `charge` real a varios
-- intentos distintos. Cualquier rol de MONEY_ROLES (frontdesk/fnb/reservations -- NO
-- requiere rol administrativo) podía así reutilizar un único cargo legítimo pequeño
-- para marcar "capturado" un número arbitrario de intentos de fuga real, inflando
-- artificialmente la tasa de captura ≥99.5% -- exactamente la métrica que este REQ
-- existe para vigilar.
--
-- Esta migración es la mitad "base de datos" del arreglo (defensa en profundidad,
-- mismo principio que el resto de este esquema: la autorización/validación de
-- aplicación en capturaCargos.ts -- monto del intento vs. monto del `charge`, con
-- tolerancia de redondeo de un centavo, mismo criterio que
-- packages/domain-hotel/src/fraude/deteccion.ts/folioEngine.ts -- nunca es la ÚNICA
-- capa). Un UNIQUE INDEX sobre `charge_id` (parcial, `where charge_id is not null`,
-- mismo patrón que el índice `room_charge_capture_attempt_charge_idx` ya creado en
-- 0131) hace fail-closed a nivel de BD la invariante "un `charge` real solo puede
-- resolver, como máximo, UN intento de captura" -- imposible de saltar aunque un
-- futuro camino de código (o un `UPDATE` directo) olvide el chequeo de aplicación.
--
-- Expand-only sobre 0131 (REQ-GOB-011): ninguna migración ya aplicada se edita; esto
-- es un índice nuevo, no un ALTER de una columna/constraint existente.
create unique index room_charge_capture_attempt_charge_id_unique_idx
  on public.room_charge_capture_attempt (charge_id)
  where charge_id is not null;
