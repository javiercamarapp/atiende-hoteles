// REQ-BO-006/GOB-041 · presentar una obligación fiscal que requiere e.firma sin una
// aprobación humana explícita registrada se rechaza -- verificado con: intento sin
// aprobación -> 0 presentaciones ejecutadas (el UPDATE completo se revierte, no solo
// el campo `status`); con aprobación de un rol NO administrativo (accountant no
// autoriza, solo prepara) -> también rechazado por RLS; con aprobación de owner/gm ->
// permitido.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("adversarial: presentación SAT con e.firma requiere aprobación humana (REQ-BO-006)", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("UPDATE status='presentada' SIN fila de aprobación se rechaza (0 presentaciones ejecutadas)", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const gm = hotel.staff.find((s) => s.role === "gm")!;

    const { rows: obligationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, requiere_efirma, due_date)
       values ($1, $2, 'iva_isr', true, current_date + 10) returning id;`,
      [fixture.seed.orgId, hotel.id],
    );
    const obligationId = obligationRows[0]!.id;

    await expect(
      fixture.engine.withAppSession({ userId: gm.id }, async (db) => {
        await db.query("update public.fiscal_obligation set status = 'presentada' where id = $1;", [obligationId]);
      }),
    ).rejects.toThrow(/presentacion_no_autorizada/);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.fiscal_obligation where id = $1;",
      [obligationId],
    );
    expect(rows[0]!.status).toBe("pendiente");
  });

  it("accountant NO puede insertar la aprobación (solo prepara, no autoriza) -- rechazado por RLS", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const accountant = hotel.staff.find((s) => s.role === "accountant")!;

    const { rows: obligationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, requiere_efirma, due_date)
       values ($1, $2, 'diot', true, current_date + 10) returning id;`,
      [fixture.seed.orgId, hotel.id],
    );
    const obligationId = obligationRows[0]!.id;

    // A diferencia de UPDATE/DELETE (0 filas afectadas, sin error), un INSERT que
    // viola el WITH CHECK de la política RLS SIEMPRE lanza (violación de política),
    // nunca inserta 0 filas en silencio.
    await expect(
      fixture.engine.withAppSession({ userId: accountant.id }, async (db) =>
        db.query(
          "insert into public.sat_filing_approval (tenant_id, hotel_id, obligation_id, approved_by) values ($1, $2, $3, $4) returning id;",
          [fixture.seed.orgId, hotel.id, obligationId, accountant.id],
        ),
      ),
    ).rejects.toThrow();

    const { rows: approvalRows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.sat_filing_approval where obligation_id = $1;",
      [obligationId],
    );
    expect(approvalRows[0]!.count).toBe("0");
  });

  it("con aprobación de gm registrada, la presentación SÍ se permite", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const gm = hotel.staff.find((s) => s.role === "gm")!;

    const { rows: obligationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, requiere_efirma, due_date)
       values ($1, $2, 'ish', true, current_date + 10) returning id;`,
      [fixture.seed.orgId, hotel.id],
    );
    const obligationId = obligationRows[0]!.id;

    await fixture.engine.withAppSession({ userId: gm.id }, async (db) => {
      await db.query(
        "insert into public.sat_filing_approval (tenant_id, hotel_id, obligation_id, approved_by, nota) values ($1, $2, $3, $4, $5);",
        [fixture.seed.orgId, hotel.id, obligationId, gm.id, "Revisado y aprobado antes de presentar"],
      );
      await db.query("update public.fiscal_obligation set status = 'presentada' where id = $1;", [obligationId]);
    });

    const { rows } = await fixture.engine.admin.query<{ status: string; presented_at: string | null }>(
      "select status, presented_at::text as presented_at from public.fiscal_obligation where id = $1;",
      [obligationId],
    );
    expect(rows[0]!.status).toBe("presentada");
    expect(rows[0]!.presented_at).not.toBeNull();
  });

  it("una obligación que NO requiere e.firma se presenta sin necesidad de aprobación", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const accountant = hotel.staff.find((s) => s.role === "accountant")!;

    const { rows: obligationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, requiere_efirma, due_date)
       values ($1, $2, 'predial', false, current_date + 10) returning id;`,
      [fixture.seed.orgId, hotel.id],
    );
    const obligationId = obligationRows[0]!.id;

    await fixture.engine.withAppSession({ userId: accountant.id }, async (db) => {
      await db.query("update public.fiscal_obligation set status = 'presentada' where id = $1;", [obligationId]);
    });

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.fiscal_obligation where id = $1;",
      [obligationId],
    );
    expect(rows[0]!.status).toBe("presentada");
  });
});
