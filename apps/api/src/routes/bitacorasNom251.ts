// REQ-AB-011 (P1/GOB, H10-016) · /hoteles/:hotelId/bitacoras-nom251 — bitácoras
// digitales de temperatura, recepción y limpieza conforme a NOM-251, capturadas de
// forma INALTERABLE (packages/db/migrations/0130_bitacora_nom251.sql, mismo patrón
// append-only + hash encadenado que attendance_log/0118) y exportables para una
// auditoría COFEPRIS.
//
//  - POST .../bitacoras-nom251: captura un renglón (owner/gm/fnb -- quien opera
//    cocina/bar). `registradoPor` SIEMPRE es la sesión real, nunca un campo del
//    cliente (ver record_bitacora_nom251_entry()).
//  - GET  .../bitacoras-nom251: historial filtrable por tipo/rango de fechas
//    (owner/gm/fnb).
//  - GET  .../bitacoras-nom251/exportar: el mismo historial de UN tipo, en CSV con los
//    campos exigidos por la norma (@atiende-hoteles/domain-hotel
//    `BITACORA_NOM251_CSV_HEADERS`/`buildBitacoraNom251Csv`), restringido a owner/gm
//    -- es el reporte de cumplimiento que se entrega al inspector, mismo criterio que
//    el ledger de consentimiento (consentimiento.ts) y el export STPS (asistencia.ts).
import { Hono } from "hono";
import { z } from "zod";
import {
  bitacoraNom251EntradaSchema,
  buildBitacoraNom251Csv,
  detectarAnomaliaBitacora,
  BITACORA_NOM251_TIPOS,
  type BitacoraNom251Entrada,
  type BitacoraNom251EntradaConMeta,
  type BitacoraNom251Tipo,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_FNB_COMPLIANCE_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const historialQuerySchema = z.object({
  tipo: z.enum(BITACORA_NOM251_TIPOS).optional(),
  desde: z.string().regex(FECHA_RE).optional(),
  hasta: z.string().regex(FECHA_RE).optional(),
});

const exportQuerySchema = z.object({
  tipo: z.enum(BITACORA_NOM251_TIPOS),
  desde: z.string().regex(FECHA_RE).optional(),
  hasta: z.string().regex(FECHA_RE).optional(),
});

interface BitacoraRow {
  id: string;
  tipo: BitacoraNom251Tipo;
  payload: unknown;
  registrado_por_nombre: string | null;
  recorded_at: string;
}

function toEntradaConMeta(row: BitacoraRow): BitacoraNom251EntradaConMeta | null {
  const parsed = bitacoraNom251EntradaSchema.safeParse({ tipo: row.tipo, payload: row.payload });
  if (!parsed.success) return null; // defensivo: un renglón viejo/corrupto no tumba el export completo
  return {
    ...(parsed.data as BitacoraNom251Entrada),
    id: row.id,
    registradoPor: row.registrado_por_nombre ?? "(desconocido)",
    registradoEn: row.recorded_at,
  };
}

export function bitacorasNom251Routes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/bitacoras-nom251",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/bitacoras-nom251/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/bitacoras-nom251", async (c) => {
    assertRole(c, MANAGE_FNB_COMPLIANCE_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(bitacoraNom251EntradaSchema, await c.req.json().catch(() => ({})));

    let row: BitacoraRow;
    try {
      const { rows } = await db.query<{
        id: string;
        tipo: string;
        payload: unknown;
        recorded_at: string;
      }>(
        `select id, tipo::text as tipo, payload, recorded_at::text as recorded_at
         from public.record_bitacora_nom251_entry($1, $2, $3);`,
        [hotelId, body.tipo, JSON.stringify(body.payload)],
      );
      const created = rows[0]!;
      row = { ...created, tipo: created.tipo as BitacoraNom251Tipo, registrado_por_nombre: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/rol_no_autorizado/.test(message)) throw Errors.forbidden("Tu rol no puede capturar bitácoras NOM-251 de este hotel.");
      throw err;
    }

    const entrada = toEntradaConMeta(row)!;
    const anomalia = detectarAnomaliaBitacora(entrada);

    return c.json(
      {
        id: row.id,
        tipo: row.tipo,
        payload: body.payload,
        registradoEn: row.recorded_at,
        anomalia: anomalia.anomalia,
        motivoAnomalia: anomalia.motivo,
      },
      201,
    );
  });

  app.get("/hoteles/:hotelId/bitacoras-nom251", async (c) => {
    assertRole(c, MANAGE_FNB_COMPLIANCE_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = historialQuerySchema.parse({
      tipo: c.req.query("tipo") || undefined,
      desde: c.req.query("desde") || undefined,
      hasta: c.req.query("hasta") || undefined,
    });

    const conditions: string[] = ["e.hotel_id = $1"];
    const params: unknown[] = [hotelId];
    if (query.tipo) {
      params.push(query.tipo);
      conditions.push(`e.tipo = $${params.length}`);
    }
    if (query.desde) {
      params.push(query.desde);
      conditions.push(`e.recorded_at >= $${params.length}::date`);
    }
    if (query.hasta) {
      params.push(query.hasta);
      conditions.push(`e.recorded_at < ($${params.length}::date + interval '1 day')`);
    }

    const { rows } = await db.query<BitacoraRow>(
      `select e.id, e.tipo::text as tipo, e.payload, e.recorded_at::text as recorded_at,
              su.full_name as registrado_por_nombre
       from public.bitacora_nom251_entry e
       left join public.staff_user su on su.id = e.registrado_por
       where ${conditions.join(" and ")}
       order by e.seq desc;`,
      params,
    );

    const entradas = rows.map(toEntradaConMeta).filter((e): e is BitacoraNom251EntradaConMeta => e !== null);

    return c.json({
      bitacoras: entradas.map((e) => ({
        id: e.id,
        tipo: e.tipo,
        payload: e.payload,
        registradoPor: e.registradoPor,
        registradoEn: e.registradoEn,
        ...detectarAnomaliaBitacora(e),
      })),
    });
  });

  app.get("/hoteles/:hotelId/bitacoras-nom251/exportar", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = exportQuerySchema.safeParse({
      tipo: c.req.query("tipo"),
      desde: c.req.query("desde") || undefined,
      hasta: c.req.query("hasta") || undefined,
    });
    if (!query.success) throw Errors.validation(`tipo es obligatorio (uno de: ${BITACORA_NOM251_TIPOS.join(", ")}).`);

    const conditions: string[] = ["e.hotel_id = $1", "e.tipo = $2"];
    const params: unknown[] = [hotelId, query.data.tipo];
    if (query.data.desde) {
      params.push(query.data.desde);
      conditions.push(`e.recorded_at >= $${params.length}::date`);
    }
    if (query.data.hasta) {
      params.push(query.data.hasta);
      conditions.push(`e.recorded_at < ($${params.length}::date + interval '1 day')`);
    }

    const { rows } = await db.query<BitacoraRow>(
      `select e.id, e.tipo::text as tipo, e.payload, e.recorded_at::text as recorded_at,
              su.full_name as registrado_por_nombre
       from public.bitacora_nom251_entry e
       left join public.staff_user su on su.id = e.registrado_por
       where ${conditions.join(" and ")}
       order by e.seq asc;`,
      params,
    );

    const entradas = rows.map(toEntradaConMeta).filter((e): e is BitacoraNom251EntradaConMeta => e !== null);
    const csv = buildBitacoraNom251Csv(query.data.tipo, entradas);

    return c.text(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bitacora-nom251-${query.data.tipo}-${hotelId}.csv"`,
    });
  });

  return app;
}
