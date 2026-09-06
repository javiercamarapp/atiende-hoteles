// H2/H5 · /hoteles/:hotelId/folios: cargos/pagos/descuentos/reverso/transferencia/
// split/cierre. Solo roles con `can_access_money()` (owner, gm, frontdesk,
// reservations, fnb, accountant) -- housekeeping/maintenance quedan excluidos en DOS
// capas: aquí (assertRole) y en la RLS de packages/db (migrations/0007_folio.sql).
//
// Motor de montos SIEMPRE en @atiende-hoteles/domain-hotel (computeChargeAmounts,
// evaluateDiscountAuthorization, evaluateFolioClose) -- ningún cálculo de dinero vive
// en esta ruta ni se delega a un LLM (ADR-006). Reversos/transferencias NUNCA borran
// una fila: insertan una nueva y usan `mark_charge_reversed()` (SECURITY DEFINER,
// migrations/0030) para marcar el origen (REQ-REC-004).
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  computeChargeAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  type ChargeConcept,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MONEY_ROLES, ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

// "descuento"/"reverso" tienen sus propios endpoints dedicados (con su propia regla
// de autorización/reverso) -- nunca se crean como un cargo genérico por esta ruta.
const chargeSchema = z.object({
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().positive(),
  impuesto: z.number().nonnegative().optional(),
  concepto: z.enum(["hospedaje", "ab", "extras", "ajuste", "propina", "otro"]).default("otro"),
});

const discountSchema = z.object({
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().positive(),
  autorizadoPorUserId: z.string().uuid().optional().nullable(),
});

const reversoSchema = z.object({
  motivo: z.string().trim().min(1).max(300),
});

const transferSchema = z.object({
  folioDestinoId: z.string().uuid(),
  motivo: z.string().trim().min(1).max(300).optional(),
});

const splitSchema = z.object({
  etiqueta: z.string().trim().min(1).max(80),
  chargeIds: z.array(z.string().uuid()).min(1),
});

const paymentSchema = z.object({
  monto: z.number().positive(),
  metodo: z.enum(["efectivo", "transferencia", "tarjeta"]),
  tokenPago: z.string().trim().min(1).max(300).optional(),
  referenciaExterna: z.string().trim().max(120).optional().nullable(),
});

const closeSchema = z.object({
  motivo: z.enum(["saldo_cero", "cuenta_por_cobrar"]),
  autorizadoPorUserId: z.string().uuid().optional().nullable(),
});

interface ChargeRow {
  id: string;
  description: string;
  amount: string;
  tax_amount: string;
  concept: ChargeConcept;
  reversed_by: string | null;
  reverses_charge_id: string | null;
  transferred_from_charge_id: string | null;
  created_at: string;
}
interface PaymentRow {
  id: string;
  amount: string;
  method: string;
  status: string;
  external_ref: string | null;
  created_at: string;
}
interface FolioRow {
  id: string;
  status: string;
  reservation_id: string;
  label: string;
  is_primary: boolean;
  closed_at: string | null;
  close_reason: string | null;
}

async function loadFolio(db: DbClient, hotelId: string, folioId: string): Promise<FolioRow> {
  const { rows } = await db.query<FolioRow>(
    `select id, status, reservation_id, label, is_primary, closed_at::text as closed_at, close_reason
     from public.folio where id = $1 and hotel_id = $2;`,
    [folioId, hotelId],
  );
  if (rows.length === 0) throw Errors.notFound("Folio no encontrado.");
  return rows[0]!;
}

async function loadCharges(db: DbClient, folioId: string): Promise<ChargeRow[]> {
  const { rows } = await db.query<ChargeRow>(
    `select id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
            transferred_from_charge_id, created_at
     from public.charge where folio_id = $1 order by created_at asc;`,
    [folioId],
  );
  return rows;
}

async function loadPayments(db: DbClient, folioId: string): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `select id, amount, method, status, external_ref, created_at
     from public.payment where folio_id = $1 order by created_at asc;`,
    [folioId],
  );
  return rows;
}

/** Saldo real del folio: TODOS los cargos suman (los reversos/descuentos ya llegan
 *  con monto negativo, así que se cancelan naturalmente -- ver
 *  packages/domain-hotel/src/folioEngine.ts) menos los pagos ya CAPTURADOS (un pago
 *  'pendiente'/'fallido' nunca reduce el saldo, REQ-BO/H15-020). */
function computeBalance(charges: ChargeRow[], payments: PaymentRow[]): number {
  const totalCharges = charges.reduce((sum, ch) => sum + Number(ch.amount) + Number(ch.tax_amount), 0);
  const totalPayments = payments.filter((p) => p.status === "capturado").reduce((sum, p) => sum + Number(p.amount), 0);
  return Math.round((totalCharges - totalPayments) * 100) / 100;
}

function serializeFolio(folio: FolioRow, charges: ChargeRow[], payments: PaymentRow[]) {
  return {
    id: folio.id,
    estado: folio.status,
    reservationId: folio.reservation_id,
    etiqueta: folio.label,
    esPrincipal: folio.is_primary,
    cerradoEn: folio.closed_at,
    motivoCierre: folio.close_reason,
    cargos: charges.map((ch) => ({
      id: ch.id,
      concepto: ch.concept,
      descripcion: ch.description,
      monto: Number(ch.amount),
      impuesto: Number(ch.tax_amount),
      revertidoPor: ch.reversed_by,
      reversaDe: ch.reverses_charge_id,
      transferidoDe: ch.transferred_from_charge_id,
      creadoEn: ch.created_at,
    })),
    pagos: payments.map((p) => ({
      id: p.id,
      monto: Number(p.amount),
      metodo: p.method,
      estado: p.status,
      referenciaExterna: p.external_ref,
      creadoEn: p.created_at,
    })),
    saldo: computeBalance(charges, payments),
  };
}

/** Verifica que `_userId` pertenezca al staff de `hotelId` con un rol administrativo
 *  (owner/gm) -- usado para autorizar un descuento/cuenta-por-cobrar aplicado por OTRO
 *  actor (p.ej. frontdesk trae la autorización de un gm que no está logueado en esta
 *  sesión). Nunca confía en un nombre/rol que venga del cuerpo de la solicitud sin
 *  verificarlo contra `hotel_staff`. */
async function isAdminStaff(db: DbClient, hotelId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ role: string }>(
    "select role from public.hotel_staff where hotel_id = $1 and user_id = $2;",
    [hotelId, userId],
  );
  return rows.length > 0 && (ADMIN_ROLES as string[]).includes(rows[0]!.role);
}

export function foliosRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/folios/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/folios",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // H5 · lista TODOS los folios de una reserva (principal + splits) -- usado por
  // /recepcion para mostrar el desglose cuando el huésped tiene más de un folio.
  app.get("/hoteles/:hotelId/reservas/:reservationId/folios", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<FolioRow>(
      `select id, status, reservation_id, label, is_primary, closed_at::text as closed_at, close_reason
       from public.folio where reservation_id = $1 and hotel_id = $2 order by is_primary desc, created_at asc;`,
      [c.req.param("reservationId"), c.req.param("hotelId")],
    );
    const folios = [];
    for (const f of rows) {
      // Un solo cliente pg por sesión (dbSession, ADR-004): las consultas de la MISMA
      // transacción deben correr en SERIE, nunca concurrentes sobre el mismo cliente.
      const charges = await loadCharges(db, f.id);
      const payments = await loadPayments(db, f.id);
      folios.push(serializeFolio(f, charges, payments));
    }
    return c.json(folios);
  });

  app.get("/hoteles/:hotelId/folios/:folioId", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const folio = await loadFolio(db, c.req.param("hotelId"), c.req.param("folioId"));
    const charges = await loadCharges(db, folio.id);
    const payments = await loadPayments(db, folio.id);
    return c.json(serializeFolio(folio, charges, payments));
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

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos cargos.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "charge.create", key: idempotencyKey, body },
      async () => {
        const taxConfig = await loadHotelMoneyConfig(db, hotelId);
        // `impuesto` explícito (compatibilidad con integraciones/tests que ya lo
        // calcularon aguas arriba) SIEMPRE se recalcula contra el motor determinista
        // salvo que el concepto sea intrínsecamente sin impuesto -- nunca se confía en
        // un impuesto que venga del cliente sin verificar (REQ-BO-001).
        const calc = computeChargeAmounts({ concept: body.concepto, netAmount: body.monto, taxConfig });
        const taxAmount = body.impuesto != null && body.concepto !== "propina" ? body.impuesto : calc.taxAmount;

        const { rows } = await db.query<{ id: string }>(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id;`,
          [orgId, hotelId, folioId, body.descripcion, calc.netAmount, taxAmount, body.concepto],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'charge.created', 'charge', $3, $4);",
          [orgId, hotelId, rows[0]!.id, JSON.stringify(body)],
        );
        return { status: 201, body: { id: rows[0]!.id, concepto: body.concepto, monto: calc.netAmount, impuesto: taxAmount } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · descuento (REQ-REC-012 estilo): bajo `discount_threshold` cualquier rol de
  // dinero lo aplica; por encima requiere que el actor SEA owner/gm, o que traiga
  // `autorizadoPorUserId` de alguien que sí lo es -- verificado contra `hotel_staff`,
  // nunca confiado del cuerpo de la solicitud (REQ-AGT-022 estilo: la identidad
  // siempre se resuelve server-side).
  app.post("/hoteles/:hotelId/folios/:folioId/descuentos", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const role = c.get("hotelRole") as HotelRole;
    const body = parseBody(discountSchema, await c.req.json().catch(() => ({})));

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite descuentos.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "charge.discount", key: idempotencyKey, body },
      async () => {
        const { discountThreshold } = await loadHotelMoneyConfig(db, hotelId);
        const authorizedByAdmin = body.autorizadoPorUserId
          ? await isAdminStaff(db, hotelId, body.autorizadoPorUserId)
          : false;

        const authorization = evaluateDiscountAuthorization({
          amount: body.monto,
          thresholdAmount: discountThreshold,
          actorHasAdminRole: (ADMIN_ROLES as string[]).includes(role),
          authorizedByAdminUserId: authorizedByAdmin ? body.autorizadoPorUserId : null,
        });
        if (!authorization.allowed) throw Errors.forbidden(authorization.reason);

        const { rows } = await db.query<{ id: string }>(
          `insert into public.charge
             (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, discount_authorized_by)
           values ($1, $2, $3, $4, $5, 0, 'descuento', $6)
           returning id;`,
          [orgId, hotelId, folioId, body.descripcion, -Math.abs(body.monto), body.autorizadoPorUserId ?? null],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'charge.discount_applied', 'charge', $3, $4);",
          [orgId, hotelId, rows[0]!.id, JSON.stringify(body)],
        );
        return { status: 201, body: { id: rows[0]!.id, monto: body.monto } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · reverso (REQ-REC-004): NUNCA borra la fila original -- inserta una nueva de
  // signo contrario y marca la original vía `mark_charge_reversed()`.
  app.post("/hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const chargeId = c.req.param("chargeId");
    const body = parseBody(reversoSchema, await c.req.json().catch(() => ({})));

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite reversos.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "charge.reverse", key: idempotencyKey, body: { chargeId, ...body } },
      async () => {
        const { rows: originalRows } = await db.query<ChargeRow>(
          `select id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
                  transferred_from_charge_id, created_at
           from public.charge where id = $1 and folio_id = $2;`,
          [chargeId, folioId],
        );
        const original = originalRows[0];
        if (!original) throw Errors.notFound("Cargo no encontrado en este folio.");
        if (original.reversed_by) throw Errors.conflict("Este cargo ya fue reversado anteriormente.");
        if (original.concept === "reverso") throw Errors.conflict("No se puede reversar un reverso.");

        const { rows: reversalRows } = await db.query<{ id: string }>(
          `insert into public.charge
             (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
           values ($1, $2, $3, $4, $5, $6, 'reverso', $7)
           returning id;`,
          [
            orgId,
            hotelId,
            folioId,
            `Reverso: ${original.description} (${body.motivo})`,
            -Number(original.amount),
            -Number(original.tax_amount),
            original.id,
          ],
        );
        const reversalId = reversalRows[0]!.id;

        await db.query("select public.mark_charge_reversed($1, $2);", [original.id, reversalId]);
        await db.query(
          "select public.record_audit_log($1, $2, 'charge.reversed', 'charge', $3, $4);",
          [orgId, hotelId, original.id, JSON.stringify({ reversalId, motivo: body.motivo })],
        );

        return { status: 201, body: { id: reversalId, reversaDe: original.id } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · transferir un cargo a OTRO folio del MISMO hotel (misma o distinta reserva):
  // reversa en origen + crea uno equivalente en destino, ambos folios deben estar
  // abiertos.
  app.post("/hoteles/:hotelId/folios/:folioId/cargos/:chargeId/transferir", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const chargeId = c.req.param("chargeId");
    const body = parseBody(transferSchema, await c.req.json().catch(() => ({})));

    if (body.folioDestinoId === folioId) throw Errors.validation("El folio destino no puede ser el mismo folio origen.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "charge.transfer", key: idempotencyKey, body: { chargeId, ...body } },
      async () => {
        const source = await loadFolio(db, hotelId, folioId);
        const destination = await loadFolio(db, hotelId, body.folioDestinoId);
        if (source.status !== "abierto") throw Errors.conflict("El folio origen está cerrado.");
        if (destination.status !== "abierto") throw Errors.conflict("El folio destino está cerrado.");

        const { rows: originalRows } = await db.query<ChargeRow>(
          `select id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
                  transferred_from_charge_id, created_at
           from public.charge where id = $1 and folio_id = $2;`,
          [chargeId, folioId],
        );
        const original = originalRows[0];
        if (!original) throw Errors.notFound("Cargo no encontrado en el folio origen.");
        if (original.reversed_by) throw Errors.conflict("Este cargo ya fue reversado/transferido anteriormente.");
        if (original.concept === "reverso" || original.concept === "descuento") {
          throw Errors.validation("Solo se transfieren cargos reales, no reversos/descuentos.");
        }

        const { rows: reversalRows } = await db.query<{ id: string }>(
          `insert into public.charge
             (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
           values ($1, $2, $3, $4, $5, $6, 'reverso', $7)
           returning id;`,
          [
            orgId,
            hotelId,
            folioId,
            `Transferido a otro folio: ${original.description}`,
            -Number(original.amount),
            -Number(original.tax_amount),
            original.id,
          ],
        );
        await db.query("select public.mark_charge_reversed($1, $2);", [original.id, reversalRows[0]!.id]);

        const { rows: newChargeRows } = await db.query<{ id: string }>(
          `insert into public.charge
             (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, transferred_from_charge_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id;`,
          [orgId, hotelId, body.folioDestinoId, original.description, original.amount, original.tax_amount, original.concept, original.id],
        );

        await db.query(
          "select public.record_audit_log($1, $2, 'charge.transferred', 'charge', $3, $4);",
          [
            orgId,
            hotelId,
            original.id,
            JSON.stringify({ folioOrigenId: folioId, folioDestinoId: body.folioDestinoId, nuevoChargeId: newChargeRows[0]!.id, motivo: body.motivo }),
          ],
        );

        return { status: 201, body: { id: newChargeRows[0]!.id, folioDestinoId: body.folioDestinoId } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · split de folio: crea un folio secundario de la MISMA reserva y transfiere a
  // él los cargos indicados (reutiliza exactamente la misma mecánica de transferencia
  // de arriba, cargo por cargo, dentro de la misma transacción de sesión).
  app.post("/hoteles/:hotelId/folios/:folioId/split", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(splitSchema, await c.req.json().catch(() => ({})));

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "folio.split", key: idempotencyKey, body },
      async () => {
        const source = await loadFolio(db, hotelId, folioId);
        if (source.status !== "abierto") throw Errors.conflict("El folio origen está cerrado.");

        const { rows: newFolioRows } = await db.query<{ id: string }>(
          `insert into public.folio (tenant_id, hotel_id, reservation_id, label, is_primary)
           values ($1, $2, $3, $4, false)
           returning id;`,
          [orgId, hotelId, source.reservation_id, body.etiqueta],
        );
        const newFolioId = newFolioRows[0]!.id;

        for (const chargeId of body.chargeIds) {
          const { rows: originalRows } = await db.query<ChargeRow>(
            `select id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
                    transferred_from_charge_id, created_at
             from public.charge where id = $1 and folio_id = $2;`,
            [chargeId, folioId],
          );
          const original = originalRows[0];
          if (!original) throw Errors.notFound(`Cargo ${chargeId} no encontrado en el folio origen.`);
          if (original.reversed_by) throw Errors.conflict(`El cargo ${chargeId} ya fue reversado/transferido.`);
          if (original.concept === "reverso" || original.concept === "descuento") {
            throw Errors.validation("Solo se transfieren cargos reales en un split, no reversos/descuentos.");
          }

          const { rows: reversalRows } = await db.query<{ id: string }>(
            `insert into public.charge
               (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
             values ($1, $2, $3, $4, $5, $6, 'reverso', $7)
             returning id;`,
            [orgId, hotelId, folioId, `Movido al folio "${body.etiqueta}": ${original.description}`, -Number(original.amount), -Number(original.tax_amount), original.id],
          );
          await db.query("select public.mark_charge_reversed($1, $2);", [original.id, reversalRows[0]!.id]);

          await db.query(
            `insert into public.charge
               (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, transferred_from_charge_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8);`,
            [orgId, hotelId, newFolioId, original.description, original.amount, original.tax_amount, original.concept, original.id],
          );
        }

        await db.query(
          "select public.record_audit_log($1, $2, 'folio.split', 'folio', $3, $4);",
          [orgId, hotelId, newFolioId, JSON.stringify({ folioOrigenId: folioId, chargeIds: body.chargeIds, etiqueta: body.etiqueta })],
        );

        return { status: 201, body: { id: newFolioId, etiqueta: body.etiqueta } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · pago (REQ-INT-002/REQ-REC-008): efectivo/transferencia se registran
  // directamente; tarjeta pasa SIEMPRE por `PaymentsPort.charge()` con un
  // `tokenPago` opaco (nunca un número de tarjeta -- el CHECK de BD
  // `payment_token_ref_not_pan` es la última línea de defensa, no la única).
  app.post("/hoteles/:hotelId/folios/:folioId/pagos", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(paymentSchema, await c.req.json().catch(() => ({})));

    if (body.metodo === "tarjeta" && !body.tokenPago) {
      throw Errors.validation("Un pago con tarjeta requiere tokenPago (nunca se acepta un número de tarjeta).");
    }

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos pagos.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "payment.create", key: idempotencyKey, body },
      async () => {
        let status = "capturado";
        let externalRef: string | null = body.referenciaExterna ?? null;
        let tokenRef: string | null = null;

        if (body.metodo === "tarjeta") {
          const paymentResult = await deps.payments.charge({
            amount: body.monto,
            currency: "MXN",
            paymentMethodToken: body.tokenPago!,
            idempotencyKey: `${orgId}:${folioId}:${idempotencyKey}`,
          });
          status = paymentResult.status;
          externalRef = paymentResult.externalPaymentId;
          tokenRef = paymentResult.externalPaymentId;
        }

        const { rows } = await db.query<{ id: string }>(
          `insert into public.payment (tenant_id, hotel_id, folio_id, amount, method, external_ref, status, token_ref)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id;`,
          [orgId, hotelId, folioId, body.monto, body.metodo, externalRef, status, tokenRef],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'payment.recorded', 'payment', $3, $4);",
          [orgId, hotelId, rows[0]!.id, JSON.stringify({ monto: body.monto, metodo: body.metodo, status })],
        );
        await db.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, 'payment', $3, 'payment.recorded', $4);`,
          [orgId, hotelId, rows[0]!.id, JSON.stringify({ paymentId: rows[0]!.id, monto: body.monto, status })],
        );

        return { status: 201, body: { id: rows[0]!.id, monto: body.monto, metodo: body.metodo, estado: status } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · cierre de folio (REQ-BO estilo): saldo cero, o cuenta por cobrar autorizada
  // por owner/gm (propio o de un tercero verificado contra hotel_staff).
  app.post("/hoteles/:hotelId/folios/:folioId/cerrar", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const role = c.get("hotelRole") as HotelRole;
    const body = parseBody(closeSchema, await c.req.json().catch(() => ({})));

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio ya está cerrado.");

    const charges = await loadCharges(db, folioId);
    const payments = await loadPayments(db, folioId);
    const balance = computeBalance(charges, payments);

    const authorizedByOtherAdmin = body.autorizadoPorUserId ? await isAdminStaff(db, hotelId, body.autorizadoPorUserId) : false;
    const evaluation = evaluateFolioClose({
      balance,
      reason: body.motivo,
      actorHasAdminRole: (ADMIN_ROLES as string[]).includes(role) || authorizedByOtherAdmin,
    });
    if (!evaluation.allowed) throw Errors.conflict(evaluation.reason ?? "No se puede cerrar el folio con estos parámetros.");

    const arApprovedBy = body.motivo === "cuenta_por_cobrar" ? body.autorizadoPorUserId ?? c.get("userId") : null;

    await db.query(
      `update public.folio
       set status = 'cerrado', closed_at = now(), close_reason = $1, ar_approved_by = $2
       where id = $3;`,
      [body.motivo, arApprovedBy, folioId],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'folio.closed', 'folio', $3, $4);",
      [orgId, hotelId, folioId, JSON.stringify({ motivo: body.motivo, balance })],
    );
    await db.query(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'folio', $3, 'folio.closed', $4);`,
      [orgId, hotelId, folioId, JSON.stringify({ motivo: body.motivo, balance })],
    );

    return c.json({ id: folioId, estado: "cerrado", motivoCierre: body.motivo, saldo: balance });
  });

  return app;
}
