// H5 · POST /hoteles/:hotelId/night-audit (REQ-REV-013/H16-003): dispara el cierre del
// día -- postea hospedaje, marca no-shows, congela el día y genera el resumen de caja.
// Ejecutable tanto por este endpoint protegido (owner/gm/accountant, para forzar/ver
// el cierre manual desde /back-office) como por un job programado (mismo
// `runNightAudit`, ver README de este módulo para el cron pendiente de
// infraestructura). Idempotente: correrlo dos veces para el MISMO business_date
// SIEMPRE devuelve el resumen ya guardado (`night_audit_claim`, migrations/0031).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import { runNightAudit } from "../jobs/nightAudit.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// accountant puede DISPARAR/consultar el cierre (parte de su función de conciliación,
// ver ADR-004 tabla de roles) además de owner/gm.
const NIGHT_AUDIT_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");
const runSchema = z.object({ businessDate: dateSchema.optional() });

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nightAuditRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/night-audit*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/night-audit", async (c) => {
    assertRole(c, NIGHT_AUDIT_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(runSchema, await c.req.json().catch(() => ({})));

    const summary = await runNightAudit(db, {
      tenantId: orgId,
      hotelId,
      businessDate: body.businessDate ?? todayIso(),
    });

    return c.json(summary, 200);
  });

  app.get("/hoteles/:hotelId/night-audit/:businessDate", async (c) => {
    assertRole(c, NIGHT_AUDIT_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const businessDate = c.req.param("businessDate");

    const { rows } = await db.query<{ status: string; summary: unknown; completed_at: string | null }>(
      "select status, summary, completed_at::text as completed_at from public.night_audit_run where hotel_id = $1 and business_date = $2::date;",
      [hotelId, businessDate],
    );
    if (rows.length === 0) throw Errors.notFound("No hay corrida de night audit para esa fecha todavía.");

    return c.json({ estado: rows[0]!.status, completadoEn: rows[0]!.completed_at, resumen: rows[0]!.summary });
  });

  // H5 · historial reciente (para /back-office "cierre diario") -- últimas N corridas.
  app.get("/hoteles/:hotelId/night-audit", async (c) => {
    assertRole(c, NIGHT_AUDIT_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows } = await db.query<{ business_date: string; status: string; completed_at: string | null }>(
      `select business_date::text as business_date, status, completed_at::text as completed_at
       from public.night_audit_run where hotel_id = $1
       order by business_date desc limit 30;`,
      [hotelId],
    );
    return c.json(rows.map((r) => ({ fecha: r.business_date, estado: r.status, completadoEn: r.completed_at })));
  });

  return app;
}
