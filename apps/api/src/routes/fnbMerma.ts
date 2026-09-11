// REQ-AB-010 (P2/F) · /hoteles/:hotelId/fnb-merma — registro de merma de inventario
// F&B clasificada por causa en cualquiera de los centros de consumo (H10-011/H10-015).
// Superficie mínima: capturar el ajuste (POST) y leerlo, crudo o resumido por causa
// (GET), para que "el 100% de los ajustes de merma quedan clasificados por causa"
// (H10-015) sea verificable con una consulta real, no solo una promesa de captura.
//
// Esto NO calcula merma teórica-vs-real por receta estándar (H12-005/REQ-AB-009,
// "pendiente-credenciales" de CFDI para conciliar contra el proveedor) ni traspasos
// entre centros de consumo/almacén central (REQ-AB-007, todavía pendiente) -- ambos
// son piezas deliberadamente más grandes y distintas; construirlas aquí duplicaría
// trabajo fuera del alcance de este requisito.
import { Hono } from "hono";
import { z } from "zod";
import {
  FNB_CENTROS_CONSUMO,
  FNB_MERMA_CAUSAS,
  FnbMermaInvalidError,
  assertValidFnbMerma,
  summarizeFnbMermaByCausa,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Quién puede capturar/ver merma -- mismo criterio que `pedidosFnb.ts`: owner/gm
// (control total) y 'fnb' (quien opera los centros de consumo). Borrar (corregir una
// captura equivocada) queda deliberadamente MÁS estricto, solo owner/gm (ver
// migración 0130_fnb_merma.sql).
const CAPTURAR_MERMA_ROLES = ["owner", "gm", "fnb"] as const;
const BORRAR_MERMA_ROLES = ["owner", "gm"] as const;

const registrarMermaSchema = z.object({
  centroConsumo: z.enum(FNB_CENTROS_CONSUMO),
  item: z.string().trim().min(1).max(150),
  cantidad: z.number().positive(),
  unidad: z.string().trim().min(1).max(20).default("unidad"),
  causa: z.enum(FNB_MERMA_CAUSAS),
  nota: z.string().trim().max(1000).optional(),
});

interface MermaRow {
  id: string;
  centro_consumo: string;
  item: string;
  cantidad: string; // numeric vuelve como string del driver -- se serializa a number abajo
  unidad: string;
  causa: string;
  nota: string | null;
  registered_by: string | null;
  created_at: string;
}

function serializeMerma(m: MermaRow) {
  return {
    id: m.id,
    centroConsumo: m.centro_consumo,
    item: m.item,
    cantidad: Number(m.cantidad),
    unidad: m.unidad,
    causa: m.causa,
    nota: m.nota,
    registradoPor: m.registered_by,
    creadoEn: m.created_at,
  };
}

export function fnbMermaRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/fnb-merma/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/fnb-merma",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Listado crudo, opcionalmente filtrado por causa/centro de consumo -- soporta el
  // caso negativo del criterio de aceptación (un registro con causa "otro" sin nota
  // nunca llega a existir, así que nunca aparece aquí sin clasificar).
  app.get("/hoteles/:hotelId/fnb-merma", async (c) => {
    assertRole(c, [...CAPTURAR_MERMA_ROLES]);
    const db = c.get("db");
    const causa = c.req.query("causa");
    const centroConsumo = c.req.query("centroConsumo");
    const conditions: string[] = ["hotel_id = $1"];
    const params: unknown[] = [c.req.param("hotelId")];
    if (causa) {
      params.push(causa);
      conditions.push(`causa = $${params.length}`);
    }
    if (centroConsumo) {
      params.push(centroConsumo);
      conditions.push(`centro_consumo = $${params.length}`);
    }
    const { rows } = await db.query<MermaRow>(
      `select id, centro_consumo, item, cantidad::text as cantidad, unidad, causa, nota, registered_by, created_at::text as created_at
       from public.fnb_merma
       where ${conditions.join(" and ")}
       order by created_at desc;`,
      params,
    );
    return c.json(rows.map(serializeMerma));
  });

  // Reporte agregado por causa (H10-015: "el 100% de los ajustes de merma quedan
  // clasificados por causa") -- función de dominio pura `summarizeFnbMermaByCausa`
  // sobre las filas reales, para que verificar "un registro por causa" no requiera que
  // cada consumidor de la API reimplemente el `group by`.
  app.get("/hoteles/:hotelId/fnb-merma/reporte-por-causa", async (c) => {
    assertRole(c, [...CAPTURAR_MERMA_ROLES]);
    const db = c.get("db");
    const { rows } = await db.query<{ causa: string; cantidad: string }>(
      "select causa, cantidad::text as cantidad from public.fnb_merma where hotel_id = $1;",
      [c.req.param("hotelId")],
    );
    const resumen = summarizeFnbMermaByCausa(rows.map((r) => ({ causa: r.causa, cantidad: Number(r.cantidad) })));
    return c.json(resumen);
  });

  app.post("/hoteles/:hotelId/fnb-merma", async (c) => {
    assertRole(c, [...CAPTURAR_MERMA_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(registrarMermaSchema, await c.req.json().catch(() => ({})));

    // Guarda de dominio ANTES de persistir (fail-closed, mismo principio que
    // `assertCanAssureDishIsSafe`): centro de consumo/causa reconocidos, cantidad
    // positiva, y causa "otro" con nota. El CHECK estructural de la migración 0130 es
    // la segunda capa por si algún llamador futuro se salta esta ruta.
    try {
      assertValidFnbMerma({
        centroConsumo: body.centroConsumo,
        causa: body.causa,
        cantidad: body.cantidad,
        nota: body.nota ?? null,
      });
    } catch (err) {
      if (err instanceof FnbMermaInvalidError) throw Errors.validation(err.message);
      throw err;
    }

    const { rows } = await db.query<MermaRow>(
      `insert into public.fnb_merma (tenant_id, hotel_id, centro_consumo, item, cantidad, unidad, causa, nota, registered_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, centro_consumo, item, cantidad::text as cantidad, unidad, causa, nota, registered_by, created_at::text as created_at;`,
      [orgId, hotelId, body.centroConsumo, body.item, body.cantidad, body.unidad, body.causa, body.nota ?? null, c.get("userId")],
    );

    return c.json(serializeMerma(rows[0]!), 201);
  });

  app.delete("/hoteles/:hotelId/fnb-merma/:mermaId", async (c) => {
    assertRole(c, [...BORRAR_MERMA_ROLES]);
    const db = c.get("db");
    const { rows } = await db.query(
      "delete from public.fnb_merma where id = $1 and hotel_id = $2 returning id;",
      [c.req.param("mermaId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Registro de merma no encontrado.");
    return c.body(null, 204);
  });

  return app;
}
