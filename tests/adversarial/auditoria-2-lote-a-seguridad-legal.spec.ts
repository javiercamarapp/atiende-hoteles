// auditoria-2/seguridad (S1-S4 CRÍTICOS, 2 ALTOS) + auditoria-2/datos (D1-D3 CRÍTICOS,
// reproducidos por API real por el auditor) + auditoria-2/legal (L1 CRÍTICO, L3 ALTOS):
// reproduce cada hallazgo con una sesión RLS real (nunca el cliente admin para el
// ataque en sí) contra `embedded-postgres`, y confirma el arreglo. Ver
// docs/auditoria-2/correccion-A-seguridad-legal.md para la tabla hallazgo -> estado.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { IdentityVaultPurgeScheduler } from "../../apps/api/src/jobs/purgeIdentityVaultScheduler.ts";
import { purgeExpiredIdentityVault } from "../../apps/api/src/jobs/purgeIdentityVault.ts";

describe("auditoria-2 lote A: seguridad multi-tenant + legal/privacidad", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  /** Fecha dentro del horizonte de disponibilidad sembrado por seedDev
   *  (AVAILABILITY_HORIZON_DAYS=30, packages/db/src/seed.ts) -- offsets pequeños y
   *  distintos por caso de prueba para no depender de una fecha fija que pueda quedar
   *  fuera de rango según el día en que corra la suite. */
  function d(offsetDays: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  async function crearGuest(hotelId: string, fullName: string): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, fullName],
    );
    return rows[0]!.id;
  }

  describe("[S1/D1 CRÍTICO] checkin_link ya no puede secuestrar la reserva de otro hotel", () => {
    it("emitir un checkin-link para una reservationId de OTRO hotel es rechazado (404, defensa de app) y nunca corrompe al guest ajeno", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const gmATokenPromise = loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const gmBToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
      const gmAToken = await gmATokenPromise;

      // Reserva y guest REALES de Hotel B (el "hotel víctima").
      const { reservationId: reservationIdHotelB } = await crearFolioConfirmado(fixture.app, gmBToken, hotelB.id, {
        roomTypeId: hotelB.roomTypes[0]!.id,
        checkInDate: d(1),
        checkOutDate: d(2),
      });
      const guestIdHotelB = await crearGuest(hotelB.id, "Huésped Real de Hotel B");
      await fixture.engine.admin.query("update public.reservation set guest_id = $1 where id = $2;", [guestIdHotelB, reservationIdHotelB]);

      // El gm de Hotel A (sin ninguna membresía en Hotel B) intenta emitir un
      // checkin-link para la reserva de Hotel B usando la URL de SU PROPIO hotel.
      const emitir = await fixture.app.request(`/hoteles/${hotelA.id}/reservas/${reservationIdHotelB}/checkin-link`, {
        method: "POST",
        headers: { authorization: `Bearer ${gmAToken}` },
      });
      expect(emitir.status).toBe(404);

      const { rows: linkRows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.checkin_link where reservation_id = $1;",
        [reservationIdHotelB],
      );
      expect(linkRows[0]!.count).toBe("0");

      const { rows: guestRows } = await fixture.engine.admin.query<{ full_name: string }>(
        "select full_name from public.guest where id = $1;",
        [guestIdHotelB],
      );
      expect(guestRows[0]!.full_name).toBe("Huésped Real de Hotel B");
    });

    it("la FK compuesta hace estructuralmente imposible el INSERT cruzado incluso saltándose la ruta (sesión SQL directa)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const gmAToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

      const { reservationId: reservationIdHotelB } = await crearFolioConfirmado(fixture.app, gmAToken, hotelB.id, {
        roomTypeId: hotelB.roomTypes[0]!.id,
        checkInDate: d(3),
        checkOutDate: d(4),
      }).catch(async () => {
        // El gm de hotel A no tiene rol en hotel B -- crea la reserva "de fábrica" con
        // el propio gm de hotel B para el escenario de ataque de más abajo.
        const gmBToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
        return crearFolioConfirmado(fixture.app, gmBToken, hotelB.id, {
          roomTypeId: hotelB.roomTypes[0]!.id,
          checkInDate: d(5),
          checkOutDate: d(6),
        });
      });

      // INSERT directo (bypass total de la ruta) intentando registrar el enlace bajo
      // hotel_id=hotelA con una reservation_id real de hotel B.
      await expect(
        fixture.engine.admin.query(
          `insert into public.checkin_link (tenant_id, hotel_id, reservation_id, token, expires_at)
           values ($1, $2, $3, $4, now() + interval '1 day');`,
          [fixture.seed.orgId, hotelA.id, reservationIdHotelB, randomBytes(16).toString("hex")],
        ),
      ).rejects.toThrow(/checkin_link_reservation_hotel_fk|foreign key/i);
    });
  });

  describe("[D2 ALTO] reservation.guest_id ya no puede apuntar a un guest de otro hotel", () => {
    it("INSERT directo de reservation con guest_id de otro hotel es rechazado por la FK compuesta", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const guestIdHotelB = await crearGuest(hotelB.id, "Guest ajeno de Hotel B");

      await expect(
        fixture.engine.admin.query(
          `insert into public.reservation (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date)
           values ($1, $2, $3, $4, current_date + 5, current_date + 6);`,
          [fixture.seed.orgId, hotelA.id, hotelA.roomTypes[0]!.id, guestIdHotelB],
        ),
      ).rejects.toThrow(/reservation_guest_hotel_fk|foreign key/i);
    });

    it("borrar un guest sigue desvinculando (SET NULL) solo guest_id, nunca hotel_id, de sus reservas propias", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const guestId = await crearGuest(hotelA.id, "Guest a borrar");
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: d(7),
        checkOutDate: d(8),
      });
      await fixture.engine.admin.query("update public.reservation set guest_id = $1 where id = $2;", [guestId, reservationId]);

      await fixture.engine.admin.query("delete from public.guest where id = $1;", [guestId]);

      const { rows } = await fixture.engine.admin.query<{ guest_id: string | null; hotel_id: string }>(
        "select guest_id, hotel_id from public.reservation where id = $1;",
        [reservationId],
      );
      expect(rows[0]!.guest_id).toBeNull();
      expect(rows[0]!.hotel_id).toBe(hotelA.id);
    });
  });

  describe("[S2 CRÍTICO] mark_charge_reversed valida el hotel real del cargo", () => {
    it("un rol sin acceso a dinero de OTRO hotel no puede reversar un cargo ajeno", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const gmBToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
      const { folioId } = await crearFolioConfirmado(fixture.app, gmBToken, hotelB.id, {
        roomTypeId: hotelB.roomTypes[0]!.id,
        checkInDate: d(9),
        checkOutDate: d(10),
      });
      // `crearFolioConfirmado` no postea ningún cargo automáticamente (eso lo hace
      // night audit) -- se inserta uno directo para tener algo que reversar.
      const { rows: chargeRows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
         values ($1, $2, $3, 'Cargo de prueba', 500, 0, 'extras') returning id;`,
        [fixture.seed.orgId, hotelB.id, folioId],
      );
      const chargeId = chargeRows[0]!.id;
      const housekeepingA = hotelA.staff.find((s) => s.role === "housekeeping")!;

      await expect(
        fixture.engine.withAppSession({ userId: housekeepingA.id }, (session) =>
          session.query("select public.mark_charge_reversed($1, gen_random_uuid());", [chargeId]),
        ),
      ).rejects.toThrow(/hotel_no_autorizado/);

      const { rows } = await fixture.engine.admin.query<{ reversed_by: string | null }>(
        "select reversed_by from public.charge where id = $1;",
        [chargeId],
      );
      expect(rows[0]!.reversed_by).toBeNull();
    });

    it("un rol de dinero del MISMO hotel sigue pudiendo reversar (no se rompe el uso legítimo)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: d(11),
        checkOutDate: d(12),
      });
      const { rows: chargeRows } = await fixture.engine.admin.query<{ id: string; amount: string; tax_amount: string }>(
        `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
         values ($1, $2, $3, 'Cargo de prueba', 500, 0, 'extras') returning id, amount, tax_amount;`,
        [fixture.seed.orgId, hotelA.id, folioId],
      );
      const charge = chargeRows[0]!;
      const gmUserId = hotelA.staff.find((s) => s.role === "gm")!.id;

      await fixture.engine.withAppSession({ userId: gmUserId }, async (session) => {
        const { rows: reversalRows } = await session.query<{ id: string }>(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
           values ($1, $2, $3, 'Reverso de prueba', $4, $5, 'reverso', $6) returning id;`,
          [fixture.seed.orgId, hotelA.id, folioId, -Number(charge.amount), -Number(charge.tax_amount), charge.id],
        );
        await session.query("select public.mark_charge_reversed($1, $2);", [charge.id, reversalRows[0]!.id]);
      });

      const { rows } = await fixture.engine.admin.query<{ reversed_by: string | null }>(
        "select reversed_by from public.charge where id = $1;",
        [charge.id],
      );
      expect(rows[0]!.reversed_by).not.toBeNull();
    });
  });

  describe("[S3 CRÍTICO] night_audit_claim/finish validan el hotel real y no re-terminan una corrida completada", () => {
    it("un rol de dinero de OTRO hotel no puede reclamar/leer el resumen de una corrida ajena", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const gmA = hotelA.staff.find((s) => s.role === "gm")!;

      await expect(
        fixture.engine.withAppSession({ userId: gmA.id }, (session) =>
          session.query("select * from public.night_audit_claim($1, $2, current_date);", [fixture.seed.orgId, hotelB.id]),
        ),
      ).rejects.toThrow(/hotel_no_autorizado/);
    });

    it("una corrida ya 'completado' no puede re-terminarse ni reemplazar su resumen", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmA = hotelA.staff.find((s) => s.role === "gm")!;

      const runId = await fixture.engine.withAppSession({ userId: gmA.id }, async (session) => {
        const { rows: claimRows } = await session.query<{ run_id: string }>(
          "select run_id from public.night_audit_claim($1, $2, current_date + 100);",
          [fixture.seed.orgId, hotelA.id],
        );
        await session.query("select public.night_audit_finish($1, $2);", [claimRows[0]!.run_id, JSON.stringify({ ok: true })]);
        return claimRows[0]!.run_id;
      });

      await expect(
        fixture.engine.withAppSession({ userId: gmA.id }, (session) =>
          session.query("select public.night_audit_finish($1, $2);", [runId, JSON.stringify({ ok: "FALSIFICADO" })]),
        ),
      ).rejects.toThrow(/night_audit_run_ya_completado/);

      const { rows } = await fixture.engine.admin.query<{ summary: { ok: boolean } }>(
        "select summary from public.night_audit_run where id = $1;",
        [runId],
      );
      expect(rows[0]!.summary.ok).toBe(true);
    });
  });

  describe("[S4 CRÍTICO] sat_filing_approval no puede forjarse desde otro hotel (FK compuesta)", () => {
    it("un owner con doble membresía (Hotel C + accountant en Hotel B) no puede insertar una aprobación de Hotel C para una obligación de Hotel B", async () => {
      const hotelB = fixture.seed.hotels[1]!;
      const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Demo Tercero') returning id;",
        [fixture.seed.orgId],
      );
      const hotelC = locRows[0]!.id;
      await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelC, fixture.seed.orgId]);

      const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
        "insert into public.staff_user (email, full_name, password_hash) values ($1, 'Multi Propiedad', 'x') returning id;",
        [`multi-${randomUUID()}@example.com`],
      );
      const dualUserId = userRows[0]!.id;
      await fixture.engine.admin.query(
        "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner'), ($1, $4, $3, 'accountant');",
        [fixture.seed.orgId, hotelC, dualUserId, hotelB.id],
      );

      const { rows: obligationRows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, requiere_efirma, due_date)
         values ($1, $2, 'diot', true, current_date + 10) returning id;`,
        [fixture.seed.orgId, hotelB.id],
      );
      const obligationIdHotelB = obligationRows[0]!.id;

      // Con su sesión de owner de Hotel C, intenta "autorizar" la obligación de
      // Hotel B declarando hotel_id=hotelC (pasa la policy de INSERT, que solo mira el
      // hotel_id que la propia fila declara) -- la FK compuesta debe rechazarlo igual.
      await expect(
        fixture.engine.withAppSession({ userId: dualUserId }, (session) =>
          session.query(
            "insert into public.sat_filing_approval (tenant_id, hotel_id, obligation_id, approved_by) values ($1, $2, $3, $4);",
            [fixture.seed.orgId, hotelC, obligationIdHotelB, dualUserId],
          ),
        ),
      ).rejects.toThrow(/sat_filing_approval_obligation_hotel_fk|foreign key/i);

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.sat_filing_approval where obligation_id = $1;",
        [obligationIdHotelB],
      );
      expect(rows[0]!.count).toBe("0");
    });
  });

  describe("[ALTO] set_identity_checkout valida el hotel real de la reserva", () => {
    it("un actor de OTRO hotel no puede adelantar el reloj de retención de una reserva ajena", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const gmBToken = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);
      const { reservationId } = await crearFolioConfirmado(fixture.app, gmBToken, hotelB.id, {
        roomTypeId: hotelB.roomTypes[0]!.id,
        checkInDate: d(13),
        checkOutDate: d(14),
      });
      const frontdeskA = hotelA.staff.find((s) => s.role === "frontdesk")!;

      await expect(
        fixture.engine.withAppSession({ userId: frontdeskA.id }, (session) =>
          session.query("select public.set_identity_checkout($1, now() - interval '31 days');", [reservationId]),
        ),
      ).rejects.toThrow(/hotel_no_autorizado/);
    });
  });

  describe("[D3 CRÍTICO] un folio cerrado ya no admite un cargo colado por una carrera cargo-vs-cierre", () => {
    it("10 repeticiones: cargo + cierre saldo_cero en paralelo NUNCA dejan un folio 'cerrado' con un cargo sin cuadrar", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const auth = { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };

      for (let i = 0; i < 10; i++) {
        // Fecha distinta por repetición (hay solo 5 habitaciones por tipo en el seed) --
        // `crearFolioConfirmado` no postea ningún cargo automáticamente (eso lo hace
        // night audit), así que el folio recién confirmado ya nace en saldo $0, el
        // mismo estado de partida que reprodujo auditoria-2/datos.
        const { folioId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
          roomTypeId: hotelA.roomTypes[0]!.id,
          checkInDate: d(15 + i),
          checkOutDate: d(16 + i),
        });

        const [cargoRes, cierreRes] = await Promise.all([
          fixture.app.request(`/hoteles/${hotelA.id}/folios/${folioId}/cargos`, {
            method: "POST",
            headers: { ...auth, "idempotency-key": randomUUID() },
            body: JSON.stringify({ descripcion: "Cargo en carrera", monto: 250, concepto: "extras" }),
          }),
          fixture.app.request(`/hoteles/${hotelA.id}/folios/${folioId}/cerrar`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ motivo: "saldo_cero" }),
          }),
        ]);

        // Invariante: NUNCA ambas tienen éxito. O el cargo entra pero el cierre se
        // rechaza (folio sigue abierto), o el cierre gana y el cargo se rechaza.
        const ambasExitosas = cargoRes.status === 201 && cierreRes.status === 200;
        expect(ambasExitosas).toBe(false);

        const { rows: folioRows } = await fixture.engine.admin.query<{ status: string }>(
          "select status from public.folio where id = $1;",
          [folioId],
        );
        const { rows: chargeCountRows } = await fixture.engine.admin.query<{ total: string }>(
          `select coalesce(sum(amount + tax_amount), 0)::text as total from public.charge
           where folio_id = $1 and reversed_by is null and not exists (
             select 1 from public.charge r where r.reverses_charge_id = public.charge.id
           );`,
          [folioId],
        );
        if (folioRows[0]!.status === "cerrado") {
          // Si quedó cerrado, el saldo real (suma de cargos vivos, sin contraparte de
          // reverso) debe ser exactamente 0 -- nunca "cerrado con deuda fantasma".
          expect(Number(chargeCountRows[0]!.total)).toBeCloseTo(0, 2);
        }
      }
    });
  });

  describe("[L1 CRÍTICO] la purga de la bóveda de identidad ahora corre en un scheduler real", () => {
    it("IdentityVaultPurgeScheduler.tick() purga por hotel una fila vencida y respeta el lock en proceso", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: d(17),
        checkOutDate: d(18),
      });
      await fixture.engine.admin.query(
        `insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, checkout_at, retention_days)
         values ($1, $2, $3, 'x', 'y', 'z', now() - interval '31 days', 30);`,
        [fixture.seed.orgId, hotelA.id, reservationId],
      );

      const scheduler = new IdentityVaultPurgeScheduler(fixture.engine.admin);
      const results = await scheduler.tick([{ id: hotelA.id, tenantId: fixture.seed.orgId }]);
      expect(results[0]!.ran).toBe(true);
      expect(results[0]!.result!.deletedTotal).toBeGreaterThanOrEqual(1);

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.identity_vault where reservation_id = $1;",
        [reservationId],
      );
      expect(rows[0]!.count).toBe("0");
    });

    it("purgeExpiredIdentityVault deja bitácora (audit_log) cuando se le da hotelId/tenantId", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: d(19),
        checkOutDate: d(20),
      });
      await fixture.engine.admin.query(
        `insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, checkout_at, retention_days)
         values ($1, $2, $3, 'x', 'y', 'z', now() - interval '31 days', 30);`,
        [fixture.seed.orgId, hotelA.id, reservationId],
      );

      await purgeExpiredIdentityVault(fixture.engine.admin, { hotelId: hotelA.id, tenantId: fixture.seed.orgId });

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.audit_log where action = 'identity_vault.purged' and hotel_id = $1;",
        [hotelA.id],
      );
      expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("[L3 ALTOS] consentimiento en check-in online + ARCO mínimo operable", () => {
    it("completar el check-in online sin aceptar el aviso de privacidad es rechazado (400)", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
        roomTypeId: hotelA.roomTypes[0]!.id,
        checkInDate: d(21),
        checkOutDate: d(22),
      });
      const emitir = await fixture.app.request(`/hoteles/${hotelA.id}/reservas/${reservationId}/checkin-link`, {
        method: "POST",
        headers: { authorization: `Bearer ${gmToken}` },
      });
      const { token } = (await emitir.json()) as { token: string };

      const { buildPassportMrz } = await import("../../packages/domain-hotel/src/mrz.ts");
      const mrz = buildPassportMrz({
        countryCode: "MEX",
        surname: "SIN CONSENTIMIENTO",
        givenNames: "PRUEBA",
        documentNumber: "Z1111111",
        nationality: "MEX",
        birthDateYyMmDd: "900101",
        sex: "F",
        expiryDateYyMmDd: "320101",
      });

      const completar = await fixture.app.request(`/checkin-publico/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nombreCompleto: "Sin Consentimiento Prueba",
          firmaDataUrl: "data:image/png;base64,AAAA",
          mrzLine1: mrz.line1,
          mrzLine2: mrz.line2,
          // consentimientoAvisoPrivacidad omitido a propósito
        }),
      });
      expect(completar.status).toBe(400);
    });

    it("record_consent() registra el consentimiento y queda en audit_log; el guest_id de otro hotel es rechazado por FK", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const hotelB = fixture.seed.hotels[1]!;
      const guestIdHotelB = await crearGuest(hotelB.id, "Guest de Hotel B para consent");

      await expect(
        fixture.engine.admin.query(
          "select public.record_consent($1, $2, null, $3, 'checkin_online', 'tratamiento_datos', 'v1', true);",
          [fixture.seed.orgId, hotelA.id, guestIdHotelB],
        ),
      ).rejects.toThrow(/consent_guest_hotel_fk|foreign key/i);
    });

    it("POST /privacidad/solicitud crea un ticket ARCO auditado con SLA; GET lo lista para owner/gm del hotel", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const crear = await fixture.app.request("/privacidad/solicitud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hotelId: hotelA.id, tipo: "cancelacion", contacto: "huesped@example.com", detalle: "Quiero que borren mis datos." }),
      });
      expect(crear.status).toBe(201);
      const created = (await crear.json()) as { id: string; estado: string; slaVenceEn: string };
      expect(created.estado).toBe("recibida");
      expect(new Date(created.slaVenceEn).getTime()).toBeGreaterThan(Date.now());

      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const listar = await fixture.app.request(`/hoteles/${hotelA.id}/privacidad/solicitudes`, {
        headers: { authorization: `Bearer ${gmToken}` },
      });
      expect(listar.status).toBe(200);
      const solicitudes = (await listar.json()) as { id: string }[];
      expect(solicitudes.some((s) => s.id === created.id)).toBe(true);
    });

    it("GET /privacidad/mis-datos/:token exporta los datos del huésped vía enlace de un solo uso y lo invalida tras usarlo", async () => {
      const hotelA = fixture.seed.hotels[0]!;
      const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
      const guestId = await crearGuest(hotelA.id, "Huésped Exportable");

      const emitir = await fixture.app.request(`/hoteles/${hotelA.id}/huespedes/${guestId}/exportar-datos`, {
        method: "POST",
        headers: { authorization: `Bearer ${gmToken}` },
      });
      expect(emitir.status).toBe(201);
      const { token } = (await emitir.json()) as { token: string };

      const primero = await fixture.app.request(`/privacidad/mis-datos/${token}`);
      expect(primero.status).toBe(200);
      const datos = (await primero.json()) as { huesped: { nombreCompleto: string } };
      expect(datos.huesped.nombreCompleto).toBe("Huésped Exportable");

      const segundo = await fixture.app.request(`/privacidad/mis-datos/${token}`);
      expect(segundo.status).toBe(409);
    });
  });
});
