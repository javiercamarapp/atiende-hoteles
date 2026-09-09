// REQ-SEG-011/H19-013/H15-020 · "los tokens de VCC/pre-autorización no utilizados
// deben purgarse/expirar automáticamente; la retención de datos de tarjeta se limita a
// lo estrictamente necesario para conciliación y disputa de contracargo." Prueba
// contra embedded-postgres real (mismo patrón que
// tests/integration/idempotency-purga-por-lote.spec.ts): una pre-autorización vencida
// se transiciona a 'expirado' y su `token_ref` se limpia; una vigente, una ya
// capturada y una sin `preauth_expires_at` (cobro directo) NUNCA se tocan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";
import { purgeExpiredPaymentPreauth } from "../../apps/api/src/jobs/purgePaymentPreauth.ts";

describe("purgeExpiredPaymentPreauth: expira y purga por lote pre-autorizaciones vencidas", () => {
  let fixture: PgFixture;
  let orgId: string;
  let hotelId: string;
  let folioId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    orgId = fixture.seed.orgId;
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    const roomType = hotel.roomTypes[0]!;

    const { rows: reservationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
       values ($1, $2, $3, current_date, current_date + 1, 1000)
       returning id;`,
      [orgId, hotelId, roomType.id],
    );
    const reservationId = reservationRows[0]!.id;

    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.folio (tenant_id, hotel_id, reservation_id) values ($1, $2, $3) returning id;`,
      [orgId, hotelId, reservationId],
    );
    folioId = folioRows[0]!.id;
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  async function insertarPago(opts: {
    label: string;
    status: string;
    tokenRef: string | null;
    preauthExpiresAtSql: string | null;
  }): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, external_ref, status, token_ref, preauth_expires_at)
       values ($1, $2, $3, 100, 'tarjeta', $4, $5, $6, ${opts.preauthExpiresAtSql ?? "null"})
       returning id;`,
      [orgId, hotelId, folioId, opts.label, opts.status, opts.tokenRef],
    );
    return rows[0]!.id;
  }

  it("expira y purga SOLO pre-autorizaciones 'autorizado' vencidas; deja intactas vigentes/capturadas/sin preauth", async () => {
    const vencidaIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      vencidaIds.push(
        await insertarPago({
          label: `vencida-${i}`,
          status: "autorizado",
          tokenRef: `tok_vencido_${i}`,
          preauthExpiresAtSql: "now() - interval '1 hour'",
        }),
      );
    }

    const vigenteId = await insertarPago({
      label: "vigente",
      status: "autorizado",
      tokenRef: "tok_vigente",
      preauthExpiresAtSql: "now() + interval '7 days'",
    });

    const capturadaId = await insertarPago({
      label: "capturada-ya-vencida-en-tiempo",
      status: "capturado",
      tokenRef: "tok_capturado",
      preauthExpiresAtSql: "now() - interval '1 hour'",
    });

    const cobroDirectoId = await insertarPago({
      label: "cobro-directo-sin-preauth",
      status: "capturado",
      tokenRef: "tok_cobro_directo",
      preauthExpiresAtSql: null,
    });

    const resultado = await purgeExpiredPaymentPreauth(fixture.engine.admin, { batchSize: 3 });

    expect(resultado.expiredTotal).toBe(7);
    expect(resultado.batches).toBe(3); // 3 + 3 + 1

    const { rows: vencidasRestantes } = await fixture.engine.admin.query<{
      id: string;
      status: string;
      token_ref: string | null;
    }>(`select id, status, token_ref from public.payment where id = any($1::uuid[]) order by id;`, [vencidaIds]);
    expect(vencidasRestantes).toHaveLength(7);
    for (const row of vencidasRestantes) {
      expect(row.status).toBe("expirado");
      expect(row.token_ref).toBeNull();
    }

    const { rows: vigenteRestante } = await fixture.engine.admin.query<{ status: string; token_ref: string | null }>(
      `select status, token_ref from public.payment where id = $1;`,
      [vigenteId],
    );
    expect(vigenteRestante[0]!.status).toBe("autorizado");
    expect(vigenteRestante[0]!.token_ref).toBe("tok_vigente");

    const { rows: capturadaRestante } = await fixture.engine.admin.query<{ status: string; token_ref: string | null }>(
      `select status, token_ref from public.payment where id = $1;`,
      [capturadaId],
    );
    expect(capturadaRestante[0]!.status).toBe("capturado");
    expect(capturadaRestante[0]!.token_ref).toBe("tok_capturado");

    const { rows: cobroDirectoRestante } = await fixture.engine.admin.query<{ status: string; token_ref: string | null }>(
      `select status, token_ref from public.payment where id = $1;`,
      [cobroDirectoId],
    );
    expect(cobroDirectoRestante[0]!.status).toBe("capturado");
    expect(cobroDirectoRestante[0]!.token_ref).toBe("tok_cobro_directo");
  });

  it("sin pre-autorizaciones vencidas, no actualiza nada y reporta 0 lotes", async () => {
    const id = await insertarPago({
      label: "sin-vencidas",
      status: "autorizado",
      tokenRef: "tok_sin_vencer",
      preauthExpiresAtSql: "now() + interval '1 day'",
    });
    const resultado = await purgeExpiredPaymentPreauth(fixture.engine.admin, { batchSize: 500, hotelId });
    expect(resultado.expiredTotal).toBe(0);
    expect(resultado.batches).toBe(0);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(`select status from public.payment where id = $1;`, [id]);
    expect(rows[0]!.status).toBe("autorizado");
  });

  it("filtra por hotelId cuando se da (planificador por hotel)", async () => {
    const idHotelActual = await insertarPago({
      label: "vencida-hotel-actual",
      status: "autorizado",
      tokenRef: "tok_hotel_actual",
      preauthExpiresAtSql: "now() - interval '1 hour'",
    });

    // segundo hotel del mismo seed -- la purga con hotelId del primero NUNCA debe
    // tocar el folio/payment de este segundo hotel.
    const hotelB = fixture.seed.hotels[1];
    if (hotelB) {
      const roomTypeB = hotelB.roomTypes[0]!;
      const { rows: reservationRowsB } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
         values ($1, $2, $3, current_date, current_date + 1, 1000)
         returning id;`,
        [orgId, hotelB.id, roomTypeB.id],
      );
      const { rows: folioRowsB } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.folio (tenant_id, hotel_id, reservation_id) values ($1, $2, $3) returning id;`,
        [orgId, hotelB.id, reservationRowsB[0]!.id],
      );
      const { rows: paymentRowsB } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, status, token_ref, preauth_expires_at)
         values ($1, $2, $3, 100, 'tarjeta', 'autorizado', 'tok_hotel_b', now() - interval '1 hour')
         returning id;`,
        [orgId, hotelB.id, folioRowsB[0]!.id],
      );

      const resultado = await purgeExpiredPaymentPreauth(fixture.engine.admin, {
        batchSize: 500,
        hotelId,
        tenantId: orgId,
      });
      expect(resultado.expiredTotal).toBe(1);

      const { rows: hotelBRestante } = await fixture.engine.admin.query<{ status: string; token_ref: string | null }>(
        `select status, token_ref from public.payment where id = $1;`,
        [paymentRowsB[0]!.id],
      );
      expect(hotelBRestante[0]!.status).toBe("autorizado");
      expect(hotelBRestante[0]!.token_ref).toBe("tok_hotel_b");

      const { rows: actualRestante } = await fixture.engine.admin.query<{ status: string }>(
        `select status from public.payment where id = $1;`,
        [idHotelActual],
      );
      expect(actualRestante[0]!.status).toBe("expirado");
    }
  });

  it("rechaza un batchSize inválido", async () => {
    await expect(purgeExpiredPaymentPreauth(fixture.engine.admin, { batchSize: 0 })).rejects.toThrow(/batch_size_invalido/);
  });
});
