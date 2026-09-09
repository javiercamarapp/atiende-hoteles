// REQ-REC-014 (P1/SEG) · detección de fraude interno cruzando PMS+POS: los 4 patrones
// del criterio de aceptación (descuentos/cortesías fuera de política, folios
// reabiertos después de auditado, cargos F&B no posteados, reembolsos a una tarjeta
// distinta de la del cargo) verificados con un caso sintético por patrón, más un
// control negativo por patrón (el flujo LEGÍTIMO equivalente no debe alertar), contra
// la app real y `embedded-postgres` (ADR-003) -- nunca contra un mock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("fraude interno (REQ-REC-014)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let fnbToken: string;
  let accountantToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    fnbToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "fnb")!.email);
    accountantToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "accountant")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  // La seed (`seedDev`) siembra tarifa/disponibilidad para los próximos 30 días
  // reales a partir de "ahora" (no de una fecha fija) -- cada escenario pide sus
  // propias 2 noches consecutivas, sin solaparse con los demás, para no depender de
  // cuántas habitaciones quedan libres por tipo.
  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }
  async function nuevaReserva() {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;
    return crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate, checkOutDate });
  }

  async function escanear(posSales: { posSaleId: string; folioId: string; monto: number }[] = []) {
    return fixture.app.request(`/hoteles/${hotelId}/fraude/escaneos`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ posSales }),
    });
  }

  interface AlertaBody {
    id: string;
    esNueva: boolean;
    patron: string;
    folioId: string | null;
    cargoId: string | null;
    pagoId: string | null;
    razon: string;
    evidencia: Record<string, unknown>;
    rolesDestinatario: string[];
  }

  // -------------------------------------------------------------------------
  // 1) Descuentos/cortesías fuera de política.
  // -------------------------------------------------------------------------
  describe("patrón 1: descuento fuera de política", () => {
    it("alerta un descuento por encima del umbral insertado SIN pasar por el endpoint autorizado (bypass)", async () => {
      const { folioId } = await nuevaReserva();

      // Bypass deliberado: inserta el cargo de descuento directo en la base de datos
      // (nunca vía /descuentos), sin `discount_authorized_by` y SIN fila de
      // audit_log asociada -- exactamente el caso que este patrón debe detectar,
      // porque una sola validación en el camino feliz nunca ve un bypass.
      const { rows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
         values ($1, $2, $3, 'Cortesía aplicada fuera de política', -800, 0, 'descuento')
         returning id;`,
        [fixture.seed.orgId, hotelId, folioId],
      );
      const chargeId = rows[0]!.id;

      const res = await escanear();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { alertas: AlertaBody[] };
      const alerta = body.alertas.find((a) => a.patron === "descuento_fuera_de_politica" && a.cargoId === chargeId);
      expect(alerta).toBeDefined();
      expect(alerta?.esNueva).toBe(true);
      expect(alerta?.folioId).toBe(folioId);
      expect(alerta?.rolesDestinatario).toEqual(["owner", "gm"]);

      const { rows: persisted } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.fraud_alert where charge_id = $1 and pattern = 'descuento_fuera_de_politica';",
        [chargeId],
      );
      expect(persisted[0]!.count).toBe("1");
    });

    it("control negativo: un descuento por encima del umbral aplicado por gm vía el endpoint real NO alerta (auto-autorizado)", async () => {
      const { folioId } = await nuevaReserva();

      const discountRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ descripcion: "Cortesía autorizada por GM", monto: 900 }),
      });
      expect(discountRes.status).toBe(201);
      const { id: chargeId } = (await discountRes.json()) as { id: string };

      const res = await escanear();
      const body = (await res.json()) as { alertas: AlertaBody[] };
      expect(body.alertas.some((a) => a.cargoId === chargeId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2) Folios reabiertos después de auditado.
  // -------------------------------------------------------------------------
  describe("patrón 2: folio reabierto después de auditado", () => {
    it("alerta un cargo posteado DESPUÉS de que el folio ya se había cerrado", async () => {
      const { folioId } = await nuevaReserva();

      const cierre = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cerrar`, {
        method: "POST",
        headers: auth(gmToken),
        body: JSON.stringify({ motivo: "saldo_cero" }),
      });
      expect(cierre.status).toBe(200);

      // Ningún endpoint de este sistema admite escribir un cargo con el folio
      // cerrado -- de hecho ni siquiera un INSERT directo a la base lo admite: hay
      // un trigger real (`charge_reject_on_closed_folio_trg`, migrations/0066) que
      // lo rechaza sin importar el rol. La ÚNICA forma de que exista un cargo con
      // `created_at` posterior a `closed_at` es que el folio se haya reabierto
      // (status vuelto a 'abierto') SIN limpiar `closed_at` -- exactamente el
      // patrón que se simula aquí (bypass directo a la base de datos: nadie expone
      // hoy un endpoint de "reabrir folio").
      await fixture.engine.admin.query("update public.folio set status = 'abierto' where id = $1;", [folioId]);

      const { rows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at)
         select $1, $2, $3, 'Cargo posteado tras reapertura no autorizada', 300, 0, 'extras',
                f.closed_at + interval '1 hour'
         from public.folio f where f.id = $3
         returning id;`,
        [fixture.seed.orgId, hotelId, folioId],
      );
      const chargeId = rows[0]!.id;

      const res = await escanear();
      const body = (await res.json()) as { alertas: AlertaBody[] };
      const alerta = body.alertas.find((a) => a.patron === "folio_reabierto_post_auditoria" && a.cargoId === chargeId);
      expect(alerta).toBeDefined();
      expect(alerta?.folioId).toBe(folioId);
      expect(alerta?.rolesDestinatario).toEqual(["owner", "gm", "accountant"]);

      // Idempotencia de escaneo: re-escanear el MISMO hallazgo no lo duplica.
      const segundoEscaneo = await escanear();
      const segundoBody = (await segundoEscaneo.json()) as { alertas: AlertaBody[] };
      const repetida = segundoBody.alertas.find((a) => a.cargoId === chargeId);
      expect(repetida?.esNueva).toBe(false);
      expect(repetida?.id).toBe(alerta?.id);

      const { rows: persisted } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.fraud_alert where charge_id = $1;",
        [chargeId],
      );
      expect(persisted[0]!.count).toBe("1");
    });

    it("control negativo: un folio abierto con cargos normales no alerta este patrón", async () => {
      const { folioId } = await nuevaReserva();
      const res = await escanear();
      const body = (await res.json()) as { alertas: AlertaBody[] };
      expect(body.alertas.some((a) => a.patron === "folio_reabierto_post_auditoria" && a.folioId === folioId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3) Cargos de F&B no posteados (reconciliación PMS vs. POS).
  // -------------------------------------------------------------------------
  describe("patrón 3: cargo F&B no posteado", () => {
    it("alerta una venta POS de F&B sin ningún cargo correspondiente en el folio", async () => {
      const { folioId } = await nuevaReserva();
      const posSaleId = `pos-${crypto.randomUUID()}`;

      const res = await escanear([{ posSaleId, folioId, monto: 480 }]);
      const body = (await res.json()) as { alertas: AlertaBody[] };
      const alerta = body.alertas.find((a) => a.patron === "cargo_fnb_no_posteado" && a.evidencia.posSaleId === posSaleId);
      expect(alerta).toBeDefined();
      expect(alerta?.cargoId).toBeNull();
      expect(alerta?.folioId).toBe(folioId);
      expect(alerta?.rolesDestinatario).toEqual(["owner", "gm", "fnb"]);
    });

    it("control negativo: una venta POS que SÍ coincide con un cargo F&B posteado no alerta", async () => {
      const { folioId } = await nuevaReserva();
      const cargoRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
        method: "POST",
        headers: { ...auth(fnbToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ descripcion: "Consumo de restaurante", monto: 480, concepto: "ab" }),
      });
      expect(cargoRes.status).toBe(201);

      const posSaleId = `pos-${crypto.randomUUID()}`;
      const res = await escanear([{ posSaleId, folioId, monto: 480 }]);
      const body = (await res.json()) as { alertas: AlertaBody[] };
      expect(body.alertas.some((a) => a.evidencia.posSaleId === posSaleId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4) Reembolsos a una tarjeta distinta de la del cargo.
  // -------------------------------------------------------------------------
  describe("patrón 4: reembolso a tarjeta distinta", () => {
    it("alerta un reembolso cuyo token de tarjeta NO coincide con ningún pago capturado del folio", async () => {
      const { folioId } = await nuevaReserva();

      const pagoRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ monto: 1000, metodo: "tarjeta", tokenPago: "tok_visa_original" }),
      });
      expect(pagoRes.status).toBe(201);

      // Simula el reembolso desviado: token de tarjeta DISTINTO al del cargo
      // original -- ningún endpoint de este sistema emite hoy un reembolso (no
      // existe una ruta de refund todavía), así que este es exactamente el estado
      // de datos que la detección debe poder encontrar sin importar cómo llegó.
      const { rows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, status, token_ref)
         values ($1, $2, $3, 1000, 'tarjeta', 'reembolsado', 'STRIPE-PAY-TARJETA-DISTINTA')
         returning id;`,
        [fixture.seed.orgId, hotelId, folioId],
      );
      const refundPaymentId = rows[0]!.id;

      const res = await escanear();
      const body = (await res.json()) as { alertas: AlertaBody[] };
      const alerta = body.alertas.find((a) => a.patron === "reembolso_tarjeta_distinta" && a.pagoId === refundPaymentId);
      expect(alerta).toBeDefined();
      expect(alerta?.folioId).toBe(folioId);
      expect(alerta?.rolesDestinatario).toEqual(["owner", "gm", "accountant"]);
    });

    it("control negativo: un reembolso al MISMO token del cargo original no alerta", async () => {
      const { folioId } = await nuevaReserva();

      const pagoRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
        method: "POST",
        headers: { ...auth(gmToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ monto: 700, metodo: "tarjeta", tokenPago: "tok_visa_legitimo" }),
      });
      expect(pagoRes.status).toBe(201);
      const { id: pagoId } = (await pagoRes.json()) as { id: string };

      const { rows: capturado } = await fixture.engine.admin.query<{ token_ref: string }>(
        "select token_ref from public.payment where id = $1;",
        [pagoId],
      );
      const tokenOriginal = capturado[0]!.token_ref;

      const { rows: refundRows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, status, token_ref)
         values ($1, $2, $3, 700, 'tarjeta', 'reembolsado', $4)
         returning id;`,
        [fixture.seed.orgId, hotelId, folioId, tokenOriginal],
      );

      const res = await escanear();
      const body = (await res.json()) as { alertas: AlertaBody[] };
      expect(body.alertas.some((a) => a.pagoId === refundRows[0]!.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Control de acceso: solo owner/gm/accountant disparan un escaneo; fnb solo
  // consulta sus propias alertas de F&B (RLS real, migrations/0095).
  // -------------------------------------------------------------------------
  describe("control de acceso por rol", () => {
    it("frontdesk NO puede disparar un escaneo ni listar alertas (403)", async () => {
      const scanRes = await fixture.app.request(`/hoteles/${hotelId}/fraude/escaneos`, {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({}),
      });
      expect(scanRes.status).toBe(403);

      const listRes = await fixture.app.request(`/hoteles/${hotelId}/fraude/alertas`, { headers: auth(frontdeskToken) });
      expect(listRes.status).toBe(403);
    });

    it("fnb SOLO ve alertas del patrón cargo_fnb_no_posteado, nunca las de otros patrones (RLS)", async () => {
      // Asegura que exista al menos una alerta de cada tipo antes de comparar listas.
      const { folioId } = await nuevaReserva();
      await escanear([{ posSaleId: `pos-rls-${crypto.randomUUID()}`, folioId, monto: 123 }]);

      const fnbList = await fixture.app.request(`/hoteles/${hotelId}/fraude/alertas`, { headers: auth(fnbToken) });
      expect(fnbList.status).toBe(200);
      const fnbAlerts = (await fnbList.json()) as { patron: string }[];
      expect(fnbAlerts.length).toBeGreaterThan(0);
      expect(fnbAlerts.every((a) => a.patron === "cargo_fnb_no_posteado")).toBe(true);

      const accountantList = await fixture.app.request(`/hoteles/${hotelId}/fraude/alertas`, { headers: auth(accountantToken) });
      expect(accountantList.status).toBe(200);
      const accountantAlerts = (await accountantList.json()) as { patron: string }[];
      // accountant ve TODOS los patrones (owner/gm/accountant, migrations/0095) --
      // en particular, más patrones distintos que lo que ve fnb.
      const patronesDistintos = new Set(accountantAlerts.map((a) => a.patron));
      expect(patronesDistintos.size).toBeGreaterThan(1);
    });
  });
});
