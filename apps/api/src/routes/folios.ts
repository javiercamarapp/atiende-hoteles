// H2 · /hoteles/:hotelId/folios/:folioId (get) + /cargos (POST, idempotente) +
// /pagos (POST, idempotente). Solo roles con `can_access_money()` (owner, gm,
// frontdesk, reservations, fnb, accountant) -- housekeeping/maintenance quedan
// excluidos en DOS capas: aquí (assertRole) y en la RLS de packages/db
// (migrations/0007_folio.sql).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MONEY_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const chargeSchema = z.object({
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().positive(),
  impuesto: z.number().nonnegative().default(0),
});

const paymentSchema = z.object({
  monto: z.number().positive(),
  metodo: z.string().trim().min(1).max(60),
  referenciaExterna: z.string().trim().max(120).optional().nullable(),
});

export function foliosRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/folios/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/folios/:folioId", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const folioId = c.req.param("folioId");
    const hotelId = c.req.param("hotelId");

    const { rows: folioRows } = await db.query<{ id: string; status: string; reservation_id: string }>(
      "select id, status, reservation_id from public.folio where id = $1 and hotel_id = $2;",
      [folioId, hotelId],
    );
    if (folioRows.length === 0) throw Errors.notFound("Folio no encontrado.");

    const { rows: charges } = await db.query<{
      id: string;
      description: string;
      amount: string;
      tax_amount: string;
      reversed_by: string | null;
      created_at: string;
    }>("select id, description, amount, tax_amount, reversed_by, created_at from public.charge where folio_id = $1 order by created_at asc;", [
      folioId,
    ]);
    const { rows: payments } = await db.query<{
      id: string;
      amount: string;
      method: string;
      external_ref: string | null;
      created_at: string;
    }>("select id, amount, method, external_ref, created_at from public.payment where folio_id = $1 order by created_at asc;", [
      folioId,
    ]);

    const totalCharges = charges
      .filter((ch) => !ch.reversed_by)
      .reduce((sum, ch) => sum + Number(ch.amount) + Number(ch.tax_amount), 0);
    const totalPayments = payments.reduce((sum, p) => sum + Number(p.amount), 0);

    return c.json({
      id: folioRows[0]!.id,
      estado: folioRows[0]!.status,
      reservationId: folioRows[0]!.reservation_id,
      cargos: charges.map((ch) => ({
        id: ch.id,
        concepto: ch.description,
        monto: Number(ch.amount),
        impuesto: Number(ch.tax_amount),
        revertidoPor: ch.reversed_by,
      })),
      pagos: payments.map((p) => ({ id: p.id, monto: Number(p.amount), metodo: p.method, referenciaExterna: p.external_ref })),
      saldo: totalCharges - totalPayments,
    });
  });

  app.post("/hoteles/:hotelId/folios/:folioId/cargos", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(chargeSchema, await c.req.json().catch(() => ({})));

    const { rows: folioRows } = await db.query<{ id: string }>(
      "select id from public.folio where id = $1 and hotel_id = $2;",
      [folioId, hotelId],
    );
    if (folioRows.length === 0) throw Errors.notFound("Folio no encontrado.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "charge.create", key: idempotencyKey, body },
      async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount)
           values ($1, $2, $3, $4, $5, $6)
           returning id;`,
          [orgId, hotelId, folioId, body.descripcion, body.monto, body.impuesto],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'charge.created', 'charge', $3, $4);",
          [orgId, hotelId, rows[0]!.id, JSON.stringify(body)],
        );
        return { status: 201, body: { id: rows[0]!.id, concepto: body.descripcion, monto: body.monto } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  app.post("/hoteles/:hotelId/folios/:folioId/pagos", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(paymentSchema, await c.req.json().catch(() => ({})));

    const { rows: folioRows } = await db.query<{ id: string }>(
      "select id from public.folio where id = $1 and hotel_id = $2;",
      [folioId, hotelId],
    );
    if (folioRows.length === 0) throw Errors.notFound("Folio no encontrado.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "payment.create", key: idempotencyKey, body },
      async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, external_ref)
           values ($1, $2, $3, $4, $5, $6)
           returning id;`,
          [orgId, hotelId, folioId, body.monto, body.metodo, body.referenciaExterna ?? null],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'payment.recorded', 'payment', $3, $4);",
          [orgId, hotelId, rows[0]!.id, JSON.stringify(body)],
        );

        await db.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, 'payment', $3, 'payment.recorded', $4);`,
          [orgId, hotelId, rows[0]!.id, JSON.stringify({ paymentId: rows[0]!.id, monto: body.monto })],
        );

        return { status: 201, body: { id: rows[0]!.id, monto: body.monto, metodo: body.metodo } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  return app;
}
