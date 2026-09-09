// REQ-QA-004 (BP-134) · Gate `money` (docs/ACEPTACION.md / docs/ACEPTACION 2.md):
// "Toda tarea con gate `money` prueba: 0 números fuera del motor de precio total
// generados por el LLM, aprobación humana existente en acciones irreversibles, y
// timbrado idempotente, antes de mergear."
//
// Este es el archivo de gate consolidado que CI debe correr (`npx vitest run
// tests/integration/gates/money.spec.ts`) antes de mergear cualquier tarea con
// `gate: money` (REQ-AGT-019/GOB-007) -- las 3 propiedades exigidas por el criterio, en
// UN solo comando, contra un `embedded-postgres` real (ADR-003), nunca un mock de base
// de datos ni de la ruta HTTP:
//
//   (1) 0 números del total de una cotización pueden venir de un LLM/canal
//       conversacional: se ejercita la ruta HTTP real (`POST /hoteles/:id/quotes`)
//       inyectando campos que un "LLM" intentaría fijar (`totalAmount`,
//       `llmSuggestedPrice`, descuentos) y se compara contra el total que el MISMO
//       camino de producción (`loadNightlyRates`/`loadTaxConfig` ->
//       `computeQuote`/`applyTaxes`, @atiende-hoteles/domain-hotel) produce de forma
//       independiente a partir de `rate_plan`/`hotel_tax_config` reales. Complementa
//       (no reemplaza) la cobertura ya existente a nivel de función pura
//       (tests/unit/domain-hotel/pricing-source.spec.ts) y de tool-calling
//       (tests/unit/agent-core/no-parallel-tool-money.spec.ts, REQ-AGT-004): aquí se
//       prueba el punto de entrada HTTP real contra Postgres real, no una unidad
//       aislada.
//
//   (2) Aprobación humana real y explícita antes de ejecutar cualquier acción
//       irreversible de dinero: se prueba en dos capas -- (a) estructural,
//       `defineTool()` hace IMPOSIBLE declarar una tool `effect="money"` sin
//       `needsApproval:true` (GOB-026), y la única tool `money` del catálogo real de
//       producción (`autorizar_gasto_mantenimiento`, apps/api/src/lib/agentTools.ts)
//       en efecto la declara; (b) end-to-end real vía HTTP + Postgres:
//       `POST /mantenimiento/:id/cerrar-con-costo` (acción irreversible: cierra el
//       ticket y fija el costo real) NUNCA ejecuta con una sola aprobación, un mismo
//       actor no puede fingir la segunda confirmación, y solo tras la aprobación de
//       DOS actores/roles reales y distintos el estado en Postgres refleja la
//       ejecución.
//
//   (3) Timbrado CFDI idempotente: la misma Idempotency-Key repetida y dos solicitudes
//       CONCURRENTES reales (Promise.all sobre el mismo folio) devuelven siempre el
//       mismo UUID fiscal y dejan exactamente 1 fila en `cfdi_emision` -- nunca un
//       doble timbrado.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAuthorizeMaintenanceExpenseTool, defineTool, ToolDefinitionError } from "@atiende-hoteles/agent-core";
import { computeQuote, parseQuoteInput } from "@atiende-hoteles/domain-hotel";
import { loadNightlyRates } from "../../../apps/api/src/pms/dbRoomRatePort.ts";
import { loadTaxConfig } from "../../../apps/api/src/pms/taxConfig.ts";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

/** Fecha futura relativa a "hoy" (nunca una fecha absoluta hardcodeada): `seedDev`
 *  siembra `rate_plan`/`availability` para los próximos 30 días desde el momento en
 *  que la prueba corre (packages/db/src/seed.ts, AVAILABILITY_HORIZON_DAYS) -- un
 *  offset pequeño y fijo mantiene esta prueba correcta sin importar cuándo se ejecute.
 */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("REQ-QA-004 (BP-134) · gate `money`: 0 números fuera del motor de precio, aprobación humana en acciones irreversibles, timbrado idempotente", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let roomCode: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 1;",
      [hotelId],
    );
    roomCode = rows[0]!.code;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function authJson(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  describe("(1) 0 números del total fuera del motor de precio total, generados por el LLM", () => {
    it("una cotización con campos inyectados por un 'canal LLM' (totalAmount/llmSuggestedPrice/descuento) devuelve EXACTAMENTE el total del motor real (rate_plan + hotel_tax_config), nunca el valor inyectado", async () => {
      const checkInDate = isoDatePlus(2);
      const checkOutDate = isoDatePlus(5); // 3 noches

      // Total "real": se deriva de forma INDEPENDIENTE del endpoint bajo prueba, por el
      // mismo camino de producción (loadNightlyRates/loadTaxConfig -> parseQuoteInput
      // -> computeQuote), para no acoplar la aserción a lo que la propia ruta devuelva.
      const taxConfig = await loadTaxConfig(fixture.engine.admin, hotelId);
      const nightlyRates = await loadNightlyRates(fixture.engine.admin, {
        hotelId,
        roomTypeId,
        fromDateInclusive: checkInDate,
        toDateInclusive: checkOutDate,
      });
      const totalReal = computeQuote(parseQuoteInput({ checkInDate, checkOutDate, taxConfig, nightlyRates })).totalAmount;
      expect(totalReal).toBeGreaterThan(0);

      const res = await fixture.app.request(`/hoteles/${hotelId}/quotes`, {
        method: "POST",
        headers: authJson(gmToken),
        body: JSON.stringify({
          roomTypeId,
          checkInDate,
          checkOutDate,
          // --- intentos de inyección de un "LLM"/cliente adversarial: ninguno de estos
          // campos existe en `quoteSchema` (apps/api/src/routes/quotes.ts), así que Zod
          // los descarta antes de que el handler los vea (mismo mecanismo verificado a
          // nivel de función pura en pricing-source.spec.ts, aquí contra la ruta real).
          totalAmount: 1,
          llmSuggestedPrice: 1,
          netAmount: 1,
          ivaAmount: 0,
          ishAmount: 0,
          descuentoPorcentaje: 90,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { totalAmount: number; netAmount: number };
      expect(body.totalAmount).toBe(totalReal);
      expect(body.totalAmount).not.toBe(1);
      expect(body.totalAmount).toBeGreaterThan(body.netAmount); // impuestos reales aplicados, nunca "0" del intento de inyección
    });

    it("dos cotizaciones idénticas por HTTP devuelven exactamente el mismo total: el motor es puro/determinista, nunca un juicio del modelo que pudiera variar entre llamadas", async () => {
      const checkInDate = isoDatePlus(10);
      const checkOutDate = isoDatePlus(11);
      const body = JSON.stringify({ roomTypeId, checkInDate, checkOutDate });

      const first = await fixture.app.request(`/hoteles/${hotelId}/quotes`, { method: "POST", headers: authJson(gmToken), body });
      const second = await fixture.app.request(`/hoteles/${hotelId}/quotes`, { method: "POST", headers: authJson(gmToken), body });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { totalAmount: number };
      const secondBody = (await second.json()) as { totalAmount: number };
      expect(secondBody.totalAmount).toBe(firstBody.totalAmount);
    });
  });

  describe('(2) aprobación humana real y explícita antes de ejecutar una acción irreversible de dinero', () => {
    it('`defineTool` hace estructuralmente imposible declarar una tool effect="money" sin needsApproval:true (GOB-026) -- no es una convención, es un error en tiempo de definición', () => {
      expect(() =>
        defineTool({
          name: "cobrar_sin_aprobacion",
          description: "intento de tool de dinero sin aprobación humana (debe rechazarse al definirse)",
          inputSchema: z.object({ montoMxn: z.number() }),
          effect: "money",
          needsApproval: false, // GOB-026 lo prohíbe
          run: () => ({ ok: true, summary: "cobrado" }),
        }),
      ).toThrow(ToolDefinitionError);
    });

    it('la única tool `effect="money"` del catálogo real de producción (autorizar_gasto_mantenimiento, apps/api/src/lib/agentTools.ts) declara needsApproval:true', () => {
      // Solo se inspecciona la DEFINICIÓN (effect/needsApproval); run() nunca se invoca
      // aquí, así que el `db` inyectado no necesita ser funcional.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mismo patrón que apps/api/src/lib/agentTools.ts: solo se lee la definición, run() no se ejecuta.
      const tool = createAuthorizeMaintenanceExpenseTool({ db: {} as any });
      expect(tool.effect).toBe("money");
      expect(tool.needsApproval).toBe(true);
    });

    it("cerrar un ticket de mantenimiento con costo real (acción irreversible: fija el gasto y cierra el ticket) NUNCA ejecuta con una sola aprobación humana, ni con el mismo actor confirmando dos veces -- solo con DOS actores/roles reales y distintos", async () => {
      const crearTicket = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento`, {
        method: "POST",
        headers: authJson(gmToken),
        body: JSON.stringify({
          roomCode,
          title: "Gate REQ-QA-004: fuga en tubería",
          description: "Fuga visible detectada durante la prueba de gate money.",
          severity: "alta",
          estimatedCost: 3000,
        }),
      });
      expect(crearTicket.status).toBe(201);
      const { ticketId } = (await crearTicket.json()) as { ticketId: string };

      const cerrar = await fixture.app.request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, {
        method: "POST",
        headers: authJson(gmToken),
        body: JSON.stringify({ actualCost: 2750, partUsed: "Válvula de repuesto" }),
      });
      expect(cerrar.status).toBe(202); // pendiente de aprobación -- NUNCA se ejecuta de inmediato
      const { aprobacionId } = (await cerrar.json()) as { aprobacionId: string };

      const ticketAntes = await fixture.engine.admin.query<{ status: string; actual_cost: string | null }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(ticketAntes.rows[0]!.status).not.toBe("cerrado");
      expect(ticketAntes.rows[0]!.actual_cost).toBeNull();

      // Primera confirmación (gm): la acción SIGUE sin ejecutarse -- solo 1 de 2
      // confirmaciones requeridas para dinero (GOB-026).
      const primeraDecision = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: authJson(gmToken),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo $2,750 MXN por la válvula." }),
      });
      expect(primeraDecision.status).toBe(200);
      expect(((await primeraDecision.json()) as { estado: string; ejecutado: boolean }).ejecutado).toBe(false);

      const ticketTrasPrimera = await fixture.engine.admin.query<{ status: string; actual_cost: string | null }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(ticketTrasPrimera.rows[0]!.status).not.toBe("cerrado");
      expect(ticketTrasPrimera.rows[0]!.actual_cost).toBeNull(); // 1 aprobación humana NO basta

      // El MISMO actor (gm) intenta simular la segunda confirmación: se rechaza
      // explícitamente (409) -- una sola persona no puede fingir "dos aprobadores".
      const mismoActorOtraVez = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: authJson(gmToken),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo $2,750 MXN por la válvula." }),
      });
      expect(mismoActorOtraVez.status).toBe(409);

      const ticketTrasActorRepetido = await fixture.engine.admin.query<{ status: string; actual_cost: string | null }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(ticketTrasActorRepetido.rows[0]!.status).not.toBe("cerrado");
      expect(ticketTrasActorRepetido.rows[0]!.actual_cost).toBeNull();

      // Segunda confirmación por un actor/rol REAL y DISTINTO (owner): ahora sí se
      // ejecuta, y el monto que queda en Postgres es exactamente el que los humanos
      // autorizaron (2750), nunca otro número.
      const segundaDecision = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, {
        method: "POST",
        headers: authJson(ownerToken),
        body: JSON.stringify({ decision: "aprobar", textoExacto: "Autorizo $2,750 MXN por la válvula." }),
      });
      expect(segundaDecision.status).toBe(200);
      const segundaBody = (await segundaDecision.json()) as { estado: string; ejecutado: boolean };
      expect(segundaBody.estado).toBe("aprobada");
      expect(segundaBody.ejecutado).toBe(true);

      const ticketFinal = await fixture.engine.admin.query<{ status: string; actual_cost: string }>(
        "select status, actual_cost from public.maintenance_ticket where id = $1;",
        [ticketId],
      );
      expect(ticketFinal.rows[0]!.status).toBe("cerrado");
      expect(Number(ticketFinal.rows[0]!.actual_cost)).toBe(2750);
    });
  });

  describe("(3) timbrado CFDI idempotente bajo repetición y concurrencia real", () => {
    async function folioConCargo(checkIn: string, checkOut: string): Promise<string> {
      const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, { roomTypeId, checkInDate: checkIn, checkOutDate: checkOut });
      await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
        method: "POST",
        headers: { ...authJson(gmToken), "idempotency-key": randomUUID() },
        body: JSON.stringify({ descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }),
      });
      return folioId;
    }

    it("misma Idempotency-Key repetida sobre el mismo folio devuelve exactamente el mismo UUID fiscal y deja 1 sola fila en cfdi_emision", async () => {
      const folioId = await folioConCargo(isoDatePlus(16), isoDatePlus(17));
      const key = randomUUID();
      const opts = {
        method: "POST" as const,
        headers: { ...authJson(gmToken), "idempotency-key": key },
        body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
      };
      const first = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, opts);
      const second = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, opts);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200); // ya existe -- nunca vuelve a timbrar
      const firstBody = (await first.json()) as { uuidFiscal: string };
      const secondBody = (await second.json()) as { uuidFiscal: string };
      expect(secondBody.uuidFiscal).toBe(firstBody.uuidFiscal);

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.cfdi_emision where folio_id = $1;",
        [folioId],
      );
      expect(rows[0]!.count).toBe("1");
    });

    it("dos solicitudes de timbrado CONCURRENTES (Promise.all, Idempotency-Keys DISTINTAS) sobre el mismo folio: Postgres garantiza exactamente 1 fila/UUID, nunca doble timbrado", async () => {
      const folioId = await folioConCargo(isoDatePlus(18), isoDatePlus(19));
      const [a, b] = await Promise.all([
        fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
          method: "POST",
          headers: { ...authJson(gmToken), "idempotency-key": randomUUID() },
          body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
        }),
        fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
          method: "POST",
          headers: { ...authJson(gmToken), "idempotency-key": randomUUID() },
          body: JSON.stringify({ esGlobal: true, metodoPago: "PUE" }),
        }),
      ]);
      expect(a.status).toBeGreaterThanOrEqual(200);
      expect(a.status).toBeLessThan(300);
      expect(b.status).toBeGreaterThanOrEqual(200);
      expect(b.status).toBeLessThan(300);

      const aBody = (await a.json()) as { uuidFiscal: string };
      const bBody = (await b.json()) as { uuidFiscal: string };
      expect(aBody.uuidFiscal).toBe(bBody.uuidFiscal);

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.cfdi_emision where folio_id = $1;",
        [folioId],
      );
      expect(rows[0]!.count).toBe("1");
    });
  });
});
