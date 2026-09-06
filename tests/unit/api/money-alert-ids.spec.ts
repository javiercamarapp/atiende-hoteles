// auditoria-2/operabilidad [MEDIO] · "La alerta del camino del dinero no lleva
// reservation_id/folio_id/charge_id" -- `route` es el PATRÓN sin resolver
// (`/hoteles/:hotelId/folios/:folioId`), y el único identificador real vivía en el
// `path` crudo de OTRA línea de log, obligando a correlacionar dos líneas por
// `request_id` a mano. Estas pruebas fijan el contrato de
// `extractMoneyIdsFromPath`/`buildMoneyAlertLog` después del fix.
import { describe, expect, it } from "vitest";
import { buildMoneyAlertLog, extractMoneyIdsFromPath } from "../../../apps/api/src/lib/moneyAlert.ts";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("extractMoneyIdsFromPath", () => {
  it("extrae folio_id de /hoteles/:hotelId/folios/:folioId/cargos", () => {
    const ids = extractMoneyIdsFromPath(`/hoteles/abc/folios/${UUID}/cargos`);
    expect(ids).toEqual({ folio_id: UUID });
  });

  it("extrae reservation_id de /hoteles/:hotelId/reservas/:reservationId/transicion", () => {
    const ids = extractMoneyIdsFromPath(`/hoteles/abc/reservas/${UUID}/transicion`);
    expect(ids).toEqual({ reservation_id: UUID });
  });

  it("extrae charge_id y folio_id juntos de una ruta de reverso", () => {
    const chargeUuid = "99999999-8888-7777-6666-555555555555";
    const ids = extractMoneyIdsFromPath(`/hoteles/abc/folios/${UUID}/cargos/${chargeUuid}/reversar`);
    expect(ids).toEqual({ folio_id: UUID, charge_id: chargeUuid });
  });

  it("un ID que no es UUID (ej. inválido a propósito, ruta rechazada con 400) no se extrae", () => {
    const ids = extractMoneyIdsFromPath("/hoteles/abc/folios/esto-no-es-un-uuid-valido");
    expect(ids).toEqual({});
  });

  it("un path sin ningún marcador de negocio conocido: objeto vacío", () => {
    expect(extractMoneyIdsFromPath("/health")).toEqual({});
  });
});

describe("buildMoneyAlertLog con rawPath", () => {
  it("incluye los IDs reales extraídos, sin perder el route-patrón", () => {
    const alerta = buildMoneyAlertLog({
      requestId: "req-1",
      route: "/hoteles/:hotelId/folios/:folioId/cargos",
      method: "POST",
      status: 500,
      rawPath: `/hoteles/hotel-1/folios/${UUID}/cargos`,
    });
    expect(alerta.route).toBe("/hoteles/:hotelId/folios/:folioId/cargos");
    expect(alerta.folio_id).toBe(UUID);
  });

  it("sin rawPath (llamador que todavía no lo pasa): no revienta, simplemente no agrega IDs", () => {
    const alerta = buildMoneyAlertLog({
      requestId: "req-1",
      route: "/hoteles/:hotelId/folios/:folioId",
      method: "GET",
      status: 500,
    });
    expect(alerta.folio_id).toBeUndefined();
  });
});
