// REQ-REV-013/H16-003 · night audit propio: postea hospedaje a folios en casa, marca
// no-shows, congela el día (corrida repetida = mismo resultado, nunca duplica cargos)
// y genera un resumen de caja -- todo vía la API real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("night audit (REQ-REV-013)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }

  async function runAudit(businessDate: string) {
    return fixture.app.request(`/hoteles/${hotelId}/night-audit`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ businessDate }),
    });
  }

  it("postea el cargo de hospedaje de la noche a un folio en casa (check_in)", async () => {
    // Fecha relativa a "ahora" (no absoluta): la seed sólo cubre tarifa/disponibilidad
    // desde "hoy" en adelante (ver comentario del test de no-show, más abajo, y
    // createApiFixture/seedDev) -- un literal fijo se queda fuera de la ventana
    // sembrada tarde o temprano (bug real de CI: la suite cruzando medianoche real deja
    // el literal "de ayer" según el current_date de Postgres). Offset +1 reservado para
    // este test en todo el archivo (ver mapa de offsets en el test de no-show).
    const businessDate = isoDate(1);
    const { reservationId, folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: businessDate,
      checkOutDate: isoDate(4),
    });
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ toStatus: "check_in" }),
    });

    const res = await runAudit(businessDate);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { postedCharges: { folioId: string }[]; yaCompletado: boolean };
    expect(summary.yaCompletado).toBe(false);
    expect(summary.postedCharges.some((p) => p.folioId === folioId)).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1 and concept = 'hospedaje' and stay_date = $2::date;",
      [folioId, businessDate],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("correr night audit DOS VECES para el mismo business_date da el MISMO resultado, sin duplicar el cargo", async () => {
    // Offset +2 reservado para este test (ver mapa de offsets en el test de no-show).
    const businessDate = isoDate(2);
    const { reservationId, folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: businessDate,
      checkOutDate: isoDate(5),
    });
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ toStatus: "check_in" }),
    });

    const first = await runAudit(businessDate);
    const firstBody = (await first.json()) as unknown;

    const second = await runAudit(businessDate);
    const secondBody = (await second.json()) as { yaCompletado: boolean };
    expect(second.status).toBe(200);
    expect(secondBody.yaCompletado).toBe(true);
    // Mismo resultado salvo la bandera `yaCompletado` (false la primera vez que se
    // calcula, true cuando se devuelve la copia ya guardada).
    expect({ ...secondBody, yaCompletado: false }).toEqual(firstBody as object);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1 and concept = 'hospedaje' and stay_date = $2::date;",
      [folioId, businessDate],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("marca no-show en el mismo cierre para una reserva confirmada cuya llegada ya pasó", async () => {
    // Fechas relativas a "ahora" (no absolutas): la seed sólo cubre tarifa/disponibilidad
    // desde "hoy" en adelante (ver createApiFixture/seedDev), así que un checkInDate
    // absoluto que quede en el pasado real (p.ej. si esta suite corre días después de
    // escrita) hace que quoteNetAmount() no encuentre tarifa y la reserva falle con 500
    // -- ya no es "llegada ya pasada" respecto al negocio, es "fuera de la ventana
    // sembrada". Lo que importa para la semántica de no-show es que checkInDate quede
    // ANTES de businessDate, no que sea anterior al reloj real.
    // Offsets +6/+7/+9 elegidos para no colisionar con los de los demás tests de este
    // archivo (+1/+2/+4/+5/+11/+13 desde "hoy", TODOS vía isoDate() desde el fix real
    // de CI: los literales absolutos "2026-09-1X" que representaban estos mismos
    // offsets en el momento de escribir el archivo dejaron de estarlo -- el 10-sep
    // real, la suite corriendo cerca de medianoche UTC hizo que el `current_date` de
    // Postgres avanzara al día siguiente antes de que corriera el primer test,
    // dejando "2026-09-10" fuera de la ventana sembrada). El night audit es
    // idempotente por business_date (ver el test de arriba), así que reusar una fecha
    // "cierra el día" para cualquier otro test que la use después.
    const checkInDate = isoDate(6);
    const checkOutDate = isoDate(7);
    const businessDate = isoDate(9);
    const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate,
      checkOutDate,
    });

    const res = await runAudit(businessDate);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { noShows: { reservationId: string }[] };
    expect(summary.noShows.some((n) => n.reservationId === reservationId)).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [reservationId],
    );
    expect(rows[0]!.status).toBe("no_show");
  });

  it("night audit disparado dos veces concurrentemente para el mismo día: exactamente un cargo por folio", async () => {
    // Offsets +11/+13 reservados para este test (ver mapa de offsets en el test de no-show).
    const businessDate = isoDate(11);
    const { reservationId, folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: businessDate,
      checkOutDate: isoDate(13),
    });
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ toStatus: "check_in" }),
    });

    const [a, b] = await Promise.all([runAudit(businessDate), runAudit(businessDate)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1 and concept = 'hospedaje' and stay_date = $2::date;",
      [folioId, businessDate],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("P1/ALTO: el resumen de caja agrupa por la FECHA DE NEGOCIO local del hotel (hotel.timezone), no por created_at::date crudo de la sesión", async () => {
    // La prueba fuerza un timezone de hotel MUY distinto del default de la sesión de
    // Postgres (para no depender de en qué huso horario corra la máquina que ejecuta
    // los tests) y elige un `created_at` cuya fecha de calendario difiere entre "cast
    // crudo" (huso de la sesión/servidor) y "hora local del hotel" -- solo el segundo
    // debe coincidir con `businessDate`.
    // Offset +4 reservado para este test (ver mapa de offsets en el test de no-show).
    const businessDate = isoDate(4);
    await fixture.engine.admin.query("update public.hotel set timezone = 'Asia/Tokyo' where id = $1;", [hotelId]);
    const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: businessDate,
      checkOutDate: isoDate(5),
    });
    // isoDate(3)T17:00:00Z == isoDate(4) 02:00 en Asia/Tokyo (UTC+9, coincide con
    // businessDate=isoDate(4)) pero isoDate(3) en cualquier huso America/* (UTC-5 a
    // UTC-8, NO coincide) -- si el fix no convierte a la hora local del hotel, este
    // cargo desaparece del resumen sin importar en qué huso corra la prueba.
    await fixture.engine.admin.query(
      `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, created_at)
       values ($1, $2, $3, 'Consumo tardío de bar', 100, 16, 'ab', $4);`,
      [fixture.seed.orgId, hotelId, folioId, `${isoDate(3)}T17:00:00Z`],
    );

    const res = await runAudit(businessDate);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cargosPorConcepto: Record<string, number> };
    // 100 (neto) + 16 (impuesto) del cargo de bar tardío, visible bajo la fecha de
    // negocio local correcta -- con el bug (created_at::date crudo) este total daba 0
    // (o solo reflejaba el cargo de hospedaje, sin el de "ab").
    expect(body.cargosPorConcepto["ab"]).toBeGreaterThanOrEqual(116);
  });

  it("housekeeping no puede disparar ni leer night audit (403)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hkToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
    const res = await fixture.app.request(`/hoteles/${hotelId}/night-audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${hkToken}`, "content-type": "application/json" },
      body: JSON.stringify({ businessDate: isoDate(1) }),
    });
    expect(res.status).toBe(403);
  });
});
