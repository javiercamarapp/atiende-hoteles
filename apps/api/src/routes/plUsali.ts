// REQ-BO-010 (P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/H17-002/H04-023):
// `GET /hoteles/:hotelId/back-office/pl-usali` -- P&L diario/mensual en formato USALI
// 12ª edición (resumen, ver alcance documentado en
// packages/db/migrations/0110_pl_usali.sql) por departamento, forecast de 90 días,
// punto de equilibrio dinámico, owner's report y proyección de caja a 13 semanas, todo
// en una sola respuesta calculada desde datos reales (charge/expense_entry/reservation).
//
// Restringido a owner/gm/accountant (`PL_ROLES`): es información financiera del
// negocio (costos/nómina/márgenes reales), más sensible que un cargo de folio
// individual -- mismo criterio de "destinatario correspondiente" que
// `routes/fraude.ts` ya aplica, espejo de `can_access_pl()` (0110) en la RLS real.
import { Hono } from "hono";
import { z } from "zod";
import { USALI_REVENUE_DEPARTMENTS, USALI_UNDISTRIBUTED_DEPARTMENTS } from "@atiende-hoteles/domain-hotel";
import { buildPlUsaliReport } from "../domain/plUsali.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import { Errors } from "../lib/errors.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export const PL_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];

// Departamentos válidos para registrar un GASTO real: los 3 operados + los 4 no
// distribuidos + 'cuota_administracion'/'no_operativo' (ver 0110_pl_usali.sql) --
// exactamente el enum `usali_department` completo.
const EXPENSE_DEPARTMENTS = [
  ...USALI_REVENUE_DEPARTMENTS,
  ...USALI_UNDISTRIBUTED_DEPARTMENTS,
  "cuota_administracion",
  "no_operativo",
] as const;

const expenseEntrySchema = z.object({
  departamento: z.enum(EXPENSE_DEPARTMENTS),
  categoria: z.enum(["costo_ventas", "nomina", "otros_gastos"]),
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().nonnegative(),
  fecha: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "debe tener formato YYYY-MM-DD"),
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string | undefined, paramName: string): string {
  if (!value || !ISO_DATE_RE.test(value)) {
    throw Errors.validation(`El parámetro "${paramName}" es obligatorio y debe tener formato YYYY-MM-DD.`);
  }
  return value;
}

export function plUsaliRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/back-office/pl-usali",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/back-office/gastos",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Registro real de un gasto departamental (REQ-BO-010: sin esto el lado de costos
  // del P&L sería inventado). Append-only -- ver 0110_pl_usali.sql, sin policy de
  // update/delete: un gasto mal capturado se corrige con una contrapartida nueva,
  // nunca editando/borrando la fila ya usada para un reporte ya emitido.
  app.post("/hoteles/:hotelId/back-office/gastos", async (c) => {
    assertRole(c, PL_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const userId = c.get("userId");
    const body = parseBody(expenseEntrySchema, await c.req.json().catch(() => ({})));

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "expense_entry.create", key: idempotencyKey, body },
      async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into public.expense_entry
             (tenant_id, hotel_id, department, category, description, amount, expense_date, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id;`,
          [orgId, hotelId, body.departamento, body.categoria, body.descripcion, body.monto, body.fecha, userId],
        );
        return { status: 201, body: { id: rows[0]!.id } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  app.get("/hoteles/:hotelId/back-office/pl-usali", async (c) => {
    assertRole(c, PL_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const desde = parseIsoDate(c.req.query("desde"), "desde");
    const hasta = parseIsoDate(c.req.query("hasta"), "hasta");
    if (desde > hasta) throw Errors.validation('El parámetro "desde" no puede ser posterior a "hasta".');

    const saldoInicialParam = c.req.query("saldoInicialCaja");
    const saldoInicialCaja = saldoInicialParam != null ? Number(saldoInicialParam) : undefined;
    if (saldoInicialParam != null && !Number.isFinite(saldoInicialCaja)) {
      throw Errors.validation('El parámetro "saldoInicialCaja" debe ser numérico.');
    }

    const report = await buildPlUsaliReport(db, hotelId, desde, hasta, { saldoInicialCaja });
    return c.json(report);
  });

  return app;
}
