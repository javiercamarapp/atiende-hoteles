// REQ-BO-010 (P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/H17-002/H04-023): verifica
// contra Postgres REAL (embedded-postgres, ADR-003) que `GET
// /hoteles/:hotelId/back-office/pl-usali` produce, con un dataset SINTÉTICO de un
// periodo CERRADO (14 días terminados AYER -- nunca "hoy", el criterio exige un
// periodo ya cerrado): el P&L en formato USALI 12ª edición (resumen, ver alcance en
// packages/db/migrations/0110_pl_usali.sql) por departamento, el punto de equilibrio
// dinámico recalculado con costos/ADR reales, el forecast de 90 días, el owner's
// report y la proyección de caja a 13 semanas -- todo a partir de ingresos reales
// (`charge.concept`, incluyendo un reverso real y una propina que debe quedar
// EXCLUIDA), gastos reales (`expense_entry`, REQ-BO-010) y reservas futuras reales "en
// libro" (`reservation`). Complementa (nunca duplica)
// tests/unit/domain-hotel/usali-pl.spec.ts, el espejo puro de la aritmética.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysStr(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDateUTC(d);
}

interface DepartmentStatementDTO {
  department: string;
  revenue: number;
  costOfSales: number;
  payroll: number;
  otherExpenses: number;
  totalExpenses: number;
  departmentalProfit: number;
  profitMarginPct: number | null;
}

describe("REQ-BO-010: P&L USALI, punto de equilibrio dinámico, forecast 90d, owner's report, caja 13 semanas", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let orgId: string;
  let gmToken: string;
  let frontdeskToken: string;

  // El periodo SIEMPRE termina AYER respecto al momento real de la corrida -- "un
  // periodo cerrado" exige que nunca incluya "hoy" (que seguiría abierto).
  const hastaDate = new Date();
  hastaDate.setUTCHours(0, 0, 0, 0);
  hastaDate.setUTCDate(hastaDate.getUTCDate() - 1);
  const hasta = isoDateUTC(hastaDate);
  const desde = addDaysStr(hasta, -13); // 14 días inclusive
  const days = Array.from({ length: 14 }, (_, i) => addDaysStr(desde, i));

  const TOTAL_PHYSICAL_ROOMS = 10; // seedDev: 2 tipos de habitación x 5 habitaciones c/u
  const OCCUPIED_ROOMS_PER_NIGHT = 5;
  const ROOMS_NIGHTLY_RATE = 1000;

  const ROOMS_EXPENSES = { costoVentas: 500, nomina: 8000, otros: 500 };
  const FB_EXPENSES = { costoVentas: 200, nomina: 150, otros: 50 };
  const OOD_EXPENSES = { costoVentas: 30, nomina: 50, otros: 20 };
  const UNDISTRIBUTED = { adminGeneral: 2000, ventasMarketing: 1000, operacionMantenimiento: 1500, utilities: 800 };
  const CUOTA_ADMINISTRACION = 3000;
  const NO_OPERATIVO = 1200;

  const FB_CHARGE_AMOUNT = 300;
  const OOD_CHARGE_AMOUNT = 150;
  const PROPINA_AMOUNT = 50;

  const SALDO_INICIAL_CAJA = 100000;
  const FUTURE_RESERVATION_WEEK1_AMOUNT = 20000;
  const FUTURE_RESERVATION_WEEK2_AMOUNT = 3000;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    orgId = fixture.seed.orgId;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    // REQ-AB-012: los cargos 'ab' insertados directo por el admin más abajo (dataset
    // sintético histórico, no pasan por la ruta HTTP) deben satisfacer igual el CHECK
    // estructural `charge_ab_requiere_identidad_verificada` (migrations/0122) --
    // evidencia sintética vía la misma válvula de escape administrativa que usa la API
    // cuando no hay huésped/teléfono real contra el cual comparar.
    const gmUserId = hotelA.staff.find((s) => s.role === "gm")!.id;

    const admin = fixture.engine.admin;
    const folioIds: string[] = [];
    let reversedChargeId = "";

    // --- 5 huéspedes ocupan una habitación cada uno las 14 noches completas --------
    for (let occupant = 0; occupant < OCCUPIED_ROOMS_PER_NIGHT; occupant += 1) {
      const { rows: resRows } = await admin.query<{ id: string }>(
        `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, status, total_amount)
         values ($1, $2, $3, $4, $5, 'cerrada', $6)
         returning id;`,
        [orgId, hotelId, roomTypeId, days[0], addDaysStr(hasta, 1), ROOMS_NIGHTLY_RATE * days.length],
      );
      const reservationId = resRows[0]!.id;
      // El folio se deja 'abierto' (default): un trigger estructural bloquea insertar
      // cargos en un folio 'cerrado' (REQ-REC-004 estilo) -- "periodo cerrado" aquí se
      // refiere al RANGO DE FECHAS ya pasado, no al estado del folio en sí.
      const { rows: folioRows } = await admin.query<{ id: string }>(
        `insert into public.folio (tenant_id, hotel_id, reservation_id)
         values ($1, $2, $3)
         returning id;`,
        [orgId, hotelId, reservationId],
      );
      const folioId = folioRows[0]!.id;
      folioIds.push(folioId);

      for (let night = 0; night < days.length; night += 1) {
        const { rows: chargeRows } = await admin.query<{ id: string }>(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, stay_date)
           values ($1, $2, $3, 'Hospedaje noche', $4, 0, 'hospedaje', $5)
           returning id;`,
          [orgId, hotelId, folioId, ROOMS_NIGHTLY_RATE, days[night]],
        );
        if (occupant === 0 && night === 9) {
          reversedChargeId = chargeRows[0]!.id;
        }
      }
    }

    // --- Reverso REAL de una noche (nunca se borra el cargo original, REQ-REC-004) --
    const { rows: reversalRows } = await admin.query<{ id: string }>(
      `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id, created_at)
       values ($1, $2, $3, 'Reverso de noche', $4, 0, 'reverso', $5, $6)
       returning id;`,
      [orgId, hotelId, folioIds[0], -ROOMS_NIGHTLY_RATE, reversedChargeId, `${days[9]}T12:00:00.000Z`],
    );
    await admin.query("update public.charge set reversed_by = $1 where id = $2;", [reversalRows[0]!.id, reversedChargeId]);

    // --- F&B (2 cargos 'ab'), Otros Departamentos ('extras'), propina EXCLUIDA ------
    await admin.query(
      `insert into public.charge
         (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at,
          identity_verified_at, identity_verified_by, identity_verification_surname_stated, identity_verification_override_by)
       values ($1, $2, $3, 'Desayuno', $4, 0, 'ab', $5, $5, $6, 'Dataset sintético REQ-BO-010', $6);`,
      [orgId, hotelId, folioIds[1], FB_CHARGE_AMOUNT, `${days[2]}T12:00:00.000Z`, gmUserId],
    );
    await admin.query(
      `insert into public.charge
         (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at,
          identity_verified_at, identity_verified_by, identity_verification_surname_stated, identity_verification_override_by)
       values ($1, $2, $3, 'Cena', $4, 0, 'ab', $5, $5, $6, 'Dataset sintético REQ-BO-010', $6);`,
      [orgId, hotelId, folioIds[2], FB_CHARGE_AMOUNT, `${days[6]}T12:00:00.000Z`, gmUserId],
    );
    await admin.query(
      `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at)
       values ($1, $2, $3, 'Spa', $4, 0, 'extras', $5);`,
      [orgId, hotelId, folioIds[3], OOD_CHARGE_AMOUNT, `${days[4]}T12:00:00.000Z`],
    );
    await admin.query(
      `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at)
       values ($1, $2, $3, 'Propina botones', $4, 0, 'propina', $5);`,
      [orgId, hotelId, folioIds[4], PROPINA_AMOUNT, `${days[7]}T12:00:00.000Z`],
    );

    // --- Gastos reales por departamento (expense_entry, 0110_pl_usali.sql) ----------
    async function gasto(department: string, category: string, amount: number): Promise<void> {
      await admin.query(
        `insert into public.expense_entry (tenant_id, hotel_id, department, category, description, amount, expense_date)
         values ($1, $2, $3, $4, 'gasto sintético', $5, $6);`,
        [orgId, hotelId, department, category, amount, days[0]],
      );
    }
    await gasto("rooms", "costo_ventas", ROOMS_EXPENSES.costoVentas);
    await gasto("rooms", "nomina", ROOMS_EXPENSES.nomina);
    await gasto("rooms", "otros_gastos", ROOMS_EXPENSES.otros);
    await gasto("food_beverage", "costo_ventas", FB_EXPENSES.costoVentas);
    await gasto("food_beverage", "nomina", FB_EXPENSES.nomina);
    await gasto("food_beverage", "otros_gastos", FB_EXPENSES.otros);
    await gasto("otros_departamentos", "costo_ventas", OOD_EXPENSES.costoVentas);
    await gasto("otros_departamentos", "nomina", OOD_EXPENSES.nomina);
    await gasto("otros_departamentos", "otros_gastos", OOD_EXPENSES.otros);
    await gasto("admin_general", "otros_gastos", UNDISTRIBUTED.adminGeneral);
    await gasto("ventas_marketing", "otros_gastos", UNDISTRIBUTED.ventasMarketing);
    await gasto("operacion_mantenimiento", "otros_gastos", UNDISTRIBUTED.operacionMantenimiento);
    await gasto("utilities", "otros_gastos", UNDISTRIBUTED.utilities);
    await gasto("cuota_administracion", "otros_gastos", CUOTA_ADMINISTRACION);
    await gasto("no_operativo", "otros_gastos", NO_OPERATIVO);

    // --- Reservas futuras "en libro" para la proyección de caja a 13 semanas --------
    await admin.query(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, status, total_amount)
       values ($1, $2, $3, $4, $5, 'confirmada', $6);`,
      [orgId, hotelId, roomTypeId, addDaysStr(hasta, 3), addDaysStr(hasta, 4), FUTURE_RESERVATION_WEEK1_AMOUNT],
    );
    await admin.query(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, status, total_amount)
       values ($1, $2, $3, $4, $5, 'confirmada', $6);`,
      [orgId, hotelId, roomTypeId, addDaysStr(hasta, 10), addDaysStr(hasta, 11), FUTURE_RESERVATION_WEEK2_AMOUNT],
    );
    // Una reserva CANCELADA en la semana 1: nunca debe contarse como ingreso "en libro".
    await admin.query(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, status, total_amount)
       values ($1, $2, $3, $4, $5, 'cancelada', 999999);`,
      [orgId, hotelId, roomTypeId, addDaysStr(hasta, 5), addDaysStr(hasta, 6)],
    );
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it("exige desde/hasta con formato YYYY-MM-DD", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/pl-usali`, { headers: auth(gmToken) });
    expect(res.status).toBe(400);
  });

  it("rechaza a un rol sin acceso al P&L (frontdesk no es owner/gm/accountant)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/pl-usali?desde=${desde}&hasta=${hasta}`, {
      headers: auth(frontdeskToken),
    });
    expect(res.status).toBe(403);
  });

  it("calcula el P&L USALI, el punto de equilibrio dinámico, el forecast de 90 días, el owner's report y la caja a 13 semanas con datos reales de un periodo cerrado", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/back-office/pl-usali?desde=${desde}&hasta=${hasta}&saldoInicialCaja=${SALDO_INICIAL_CAJA}`,
      { headers: auth(gmToken) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      periodo: { desde: string; hasta: string };
      diario: { pl: { ingresosTotales: number } }[];
      mensual: { pl: { ingresosTotales: number } }[];
      total: {
        departamentos: DepartmentStatementDTO[];
        ingresosTotales: number;
        utilidadDepartamentalTotal: number;
        totalGastosNoDistribuidos: number;
        gop: number;
        cuotaAdministracion: number;
        ebitda: number;
        gastosNoOperativos: number;
        utilidadNeta: number;
      };
      kpis: { adr: number; revpar: number; occupancyPct: number; occupiedRoomNights: number; availableRoomNights: number };
      puntoEquilibrio: {
        fixedCostsNetOfOtherDepartments: number;
        contributionMarginPerRoom: number;
        breakevenOccupiedRoomNights: number;
        breakevenOccupancyPct: number;
        actualOccupancyPct: number;
        occupancyGapPct: number;
      };
      forecast90d: { horizonDias: number; puntos: { fecha: string; stepsAhead: number }[] } | null;
      flujoCaja13Semanas: { weekStart: string; onBooksInflow: number; expenseRunRate: number; netChange: number }[];
      ownersReport: {
        porEncimaDePuntoDeEquilibrio: boolean | null;
        alertas: string[];
        cashSummary: { saldoInicial: number; saldoFinal13Semanas: number; cambioNetoTotal: number; semanasConFlujoNegativo: number };
        pl: { gop: number };
      };
    };

    // --- Números esperados, derivados de las CONSTANTES sembradas arriba (nunca del
    //     propio código bajo prueba) --------------------------------------------------
    const occupiedRoomNights = OCCUPIED_ROOMS_PER_NIGHT * days.length - 1; // 1 noche reversada
    const roomsRevenue = occupiedRoomNights * ROOMS_NIGHTLY_RATE;
    const fbRevenue = FB_CHARGE_AMOUNT * 2;
    const oodRevenue = OOD_CHARGE_AMOUNT;
    const roomsExpensesTotal = ROOMS_EXPENSES.costoVentas + ROOMS_EXPENSES.nomina + ROOMS_EXPENSES.otros;
    const fbExpensesTotal = FB_EXPENSES.costoVentas + FB_EXPENSES.nomina + FB_EXPENSES.otros;
    const oodExpensesTotal = OOD_EXPENSES.costoVentas + OOD_EXPENSES.nomina + OOD_EXPENSES.otros;
    const ingresosTotales = roomsRevenue + fbRevenue + oodRevenue;

    expect(body.periodo).toEqual({ desde, hasta });

    // --- 1) P&L USALI por departamento -----------------------------------------------
    const rooms = body.total.departamentos.find((d) => d.department === "rooms")!;
    expect(rooms.revenue).toBe(roomsRevenue);
    expect(rooms.costOfSales).toBe(ROOMS_EXPENSES.costoVentas);
    expect(rooms.payroll).toBe(ROOMS_EXPENSES.nomina);
    expect(rooms.otherExpenses).toBe(ROOMS_EXPENSES.otros);
    expect(rooms.totalExpenses).toBe(roomsExpensesTotal);
    expect(rooms.departmentalProfit).toBe(roomsRevenue - roomsExpensesTotal);

    const fb = body.total.departamentos.find((d) => d.department === "food_beverage")!;
    expect(fb.revenue).toBe(fbRevenue);
    expect(fb.totalExpenses).toBe(fbExpensesTotal);
    expect(fb.departmentalProfit).toBe(fbRevenue - fbExpensesTotal);

    const ood = body.total.departamentos.find((d) => d.department === "otros_departamentos")!;
    expect(ood.revenue).toBe(oodRevenue);
    expect(ood.totalExpenses).toBe(oodExpensesTotal);
    expect(ood.departmentalProfit).toBe(oodRevenue - oodExpensesTotal);

    // La propina NUNCA es ingreso del hotel (mismo criterio que folioEngine.ts aplica
    // para impuestos) -- si se hubiera contado, ingresosTotales sería 50 más.
    expect(body.total.ingresosTotales).toBe(ingresosTotales);

    const utilidadDepartamentalTotal = rooms.departmentalProfit + fb.departmentalProfit + ood.departmentalProfit;
    expect(body.total.utilidadDepartamentalTotal).toBe(utilidadDepartamentalTotal);

    const totalGastosNoDistribuidos =
      UNDISTRIBUTED.adminGeneral + UNDISTRIBUTED.ventasMarketing + UNDISTRIBUTED.operacionMantenimiento + UNDISTRIBUTED.utilities;
    expect(body.total.totalGastosNoDistribuidos).toBe(totalGastosNoDistribuidos);

    const gop = utilidadDepartamentalTotal - totalGastosNoDistribuidos;
    expect(body.total.gop).toBe(gop);
    expect(body.total.cuotaAdministracion).toBe(CUOTA_ADMINISTRACION);
    expect(body.total.ebitda).toBe(gop - CUOTA_ADMINISTRACION);
    expect(body.total.gastosNoOperativos).toBe(NO_OPERATIVO);
    expect(body.total.utilidadNeta).toBe(gop - CUOTA_ADMINISTRACION - NO_OPERATIVO);

    // --- KPIs reales (ADR/RevPAR/ocupación, base del punto de equilibrio) -----------
    const availableRoomNights = TOTAL_PHYSICAL_ROOMS * days.length;
    expect(body.kpis.occupiedRoomNights).toBe(occupiedRoomNights);
    expect(body.kpis.availableRoomNights).toBe(availableRoomNights);
    expect(body.kpis.adr).toBeCloseTo(roomsRevenue / occupiedRoomNights, 6);
    expect(body.kpis.revpar).toBeCloseTo(roomsRevenue / availableRoomNights, 6);
    expect(body.kpis.occupancyPct).toBeCloseTo((occupiedRoomNights / availableRoomNights) * 100, 6);

    // --- 3) Punto de equilibrio dinámico ---------------------------------------------
    const otherDepartmentsProfit = fb.departmentalProfit + ood.departmentalProfit;
    const fixedCosts = totalGastosNoDistribuidos + CUOTA_ADMINISTRACION + NO_OPERATIVO;
    const fixedCostsNet = fixedCosts - otherDepartmentsProfit;
    const realAdr = roomsRevenue / occupiedRoomNights;
    const roomsVariableCostPerRoom = roomsExpensesTotal / occupiedRoomNights;
    const contributionMargin = realAdr - roomsVariableCostPerRoom;
    const breakevenRoomNights = fixedCostsNet / contributionMargin;
    const breakevenOccupancyPct = (breakevenRoomNights / availableRoomNights) * 100;

    expect(body.puntoEquilibrio.fixedCostsNetOfOtherDepartments).toBeCloseTo(fixedCostsNet, 6);
    expect(body.puntoEquilibrio.contributionMarginPerRoom).toBeCloseTo(contributionMargin, 6);
    expect(body.puntoEquilibrio.breakevenOccupiedRoomNights).toBeCloseTo(breakevenRoomNights, 6);
    expect(body.puntoEquilibrio.breakevenOccupancyPct).toBeCloseTo(breakevenOccupancyPct, 6);
    expect(body.puntoEquilibrio.occupancyGapPct).toBeGreaterThan(0); // negocio saludable, por encima del equilibrio

    // --- 2) Forecast de 90 días -------------------------------------------------------
    expect(body.forecast90d).not.toBeNull();
    expect(body.forecast90d!.horizonDias).toBe(90);
    expect(body.forecast90d!.puntos).toHaveLength(90);
    expect(body.forecast90d!.puntos[0]!.fecha).toBe(addDaysStr(hasta, 1));
    expect(body.forecast90d!.puntos[89]!.fecha).toBe(addDaysStr(hasta, 90));
    expect(body.forecast90d!.puntos.map((p) => p.stepsAhead)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));

    // --- 5) Proyección de caja a 13 semanas ------------------------------------------
    expect(body.flujoCaja13Semanas).toHaveLength(13);
    const totalExpensesPeriodo =
      roomsExpensesTotal + fbExpensesTotal + oodExpensesTotal + totalGastosNoDistribuidos + CUOTA_ADMINISTRACION + NO_OPERATIVO;
    const expenseRunRatePerWeek = totalExpensesPeriodo / (days.length / 7);

    const week1 = body.flujoCaja13Semanas[0]!;
    expect(week1.weekStart).toBe(addDaysStr(hasta, 1));
    expect(week1.onBooksInflow).toBe(FUTURE_RESERVATION_WEEK1_AMOUNT); // la cancelada NUNCA cuenta
    expect(week1.expenseRunRate).toBeCloseTo(expenseRunRatePerWeek, 6);
    expect(week1.netChange).toBeCloseTo(FUTURE_RESERVATION_WEEK1_AMOUNT - expenseRunRatePerWeek, 6);

    const week2 = body.flujoCaja13Semanas[1]!;
    expect(week2.onBooksInflow).toBe(FUTURE_RESERVATION_WEEK2_AMOUNT);

    for (let i = 2; i < 13; i += 1) {
      expect(body.flujoCaja13Semanas[i]!.onBooksInflow).toBe(0);
    }

    const netChanges = body.flujoCaja13Semanas.map((w) => w.netChange);
    const sumNet = netChanges.reduce((a, b) => a + b, 0);
    expect(body.ownersReport.cashSummary.saldoInicial).toBe(SALDO_INICIAL_CAJA);
    expect(body.ownersReport.cashSummary.cambioNetoTotal).toBeCloseTo(sumNet, 6);
    expect(body.ownersReport.cashSummary.saldoFinal13Semanas).toBeCloseTo(SALDO_INICIAL_CAJA + sumNet, 6);
    expect(body.ownersReport.cashSummary.semanasConFlujoNegativo).toBe(netChanges.filter((n) => n < 0).length);

    // --- 4) Owner's report -------------------------------------------------------------
    expect(body.ownersReport.porEncimaDePuntoDeEquilibrio).toBe(true);
    expect(body.ownersReport.pl.gop).toBe(gop);
    expect(Array.isArray(body.ownersReport.alertas)).toBe(true);

    // --- P&L diario/mensual: cada corte reproduce, sumado, el total del periodo -----
    expect(body.diario).toHaveLength(14);
    const sumaDiaria = body.diario.reduce((sum, p) => sum + p.pl.ingresosTotales, 0);
    expect(sumaDiaria).toBeCloseTo(ingresosTotales, 6);
    expect(body.mensual.length).toBeGreaterThanOrEqual(1);
    const sumaMensual = body.mensual.reduce((sum, p) => sum + p.pl.ingresosTotales, 0);
    expect(sumaMensual).toBeCloseTo(ingresosTotales, 6);
  });

  it("registra un gasto real vía POST /back-office/gastos (exige Idempotency-Key)", async () => {
    const sinIdempotencia = await fixture.app.request(`/hoteles/${hotelId}/back-office/gastos`, {
      method: "POST",
      headers: { ...auth(gmToken), "content-type": "application/json" },
      body: JSON.stringify({ departamento: "utilities", categoria: "otros_gastos", descripcion: "Luz", monto: 100, fecha: hasta }),
    });
    expect(sinIdempotencia.status).toBe(400);

    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/gastos`, {
      method: "POST",
      headers: { ...auth(gmToken), "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ departamento: "utilities", categoria: "otros_gastos", descripcion: "Luz", monto: 100, fecha: hasta }),
    });
    expect(res.status).toBe(201);

    const forbidden = await fixture.app.request(`/hoteles/${hotelId}/back-office/gastos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ departamento: "utilities", categoria: "otros_gastos", descripcion: "Luz", monto: 100, fecha: hasta }),
    });
    expect(forbidden.status).toBe(403);
  });
});
