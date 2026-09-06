// H7 · `GET /hoteles/:hotelId/roi` (REQ-AGT-003/REQ-REV-018, H17-001): lista los
// `roi_event` del hotel con sus 4 campos exigidos por H17 (monto verificado/estimado,
// método contrafactual, confianza) y la suma acumulada -- SIEMPRE con
// `supuestoVersion` visible y `estimado: true` cuando no hay monto verificado (columna
// derivada en BD, 0026, nunca confiada a la aplicación). Sin línea base firmada
// (REQ-REV-018) este endpoint solo EXPONE los eventos capturados, no habilita ningún
// cobro por resultado -- esa lógica de facturación queda pendiente (ver README).
import { Hono } from "hono";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

interface RoiEventRow {
  id: string;
  agent_name: string;
  tipo_evento: string;
  monto_estimado: string | null;
  monto_verificado: string | null;
  metodo_contrafactual: string;
  confianza: string;
  supuesto_version: string;
  estimado: boolean;
  referencia_tipo: string;
  referencia_codigo: string | null;
  notas: string | null;
  created_at: string;
}

export function roiRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/roi", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));

  app.get("/hoteles/:hotelId/roi", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const agente = c.req.query("agente");

    const { rows } = await db.query<RoiEventRow>(
      `select id, agent_name, tipo_evento, monto_estimado::text as monto_estimado,
              monto_verificado::text as monto_verificado, metodo_contrafactual, confianza::text as confianza,
              supuesto_version, estimado, referencia_tipo, referencia_codigo, notas, created_at::text as created_at
       from public.roi_event
       where hotel_id = $1 and ($2::text is null or agent_name = $2)
       order by created_at desc
       limit 500;`,
      [hotelId, agente ?? null],
    );

    const eventos = rows.map((r) => ({
      id: r.id,
      agente: r.agent_name,
      tipoEvento: r.tipo_evento,
      montoEstimado: r.monto_estimado != null ? Number(r.monto_estimado) : null,
      montoVerificado: r.monto_verificado != null ? Number(r.monto_verificado) : null,
      metodoContrafactual: r.metodo_contrafactual,
      confianza: Number(r.confianza),
      supuestoVersion: r.supuesto_version,
      estimado: r.estimado,
      referenciaTipo: r.referencia_tipo,
      referenciaCodigo: r.referencia_codigo,
      notas: r.notas,
      creadoEn: r.created_at,
    }));

    const sumaEstimadoUsd = eventos.reduce((total, e) => total + (e.montoVerificado ?? e.montoEstimado ?? 0), 0);
    const sumaVerificadoUsd = eventos.reduce((total, e) => total + (e.montoVerificado ?? 0), 0);
    const supuestoVersion = eventos[0]?.supuestoVersion ?? "H17-v1";

    return c.json({
      eventos,
      sumaEstimadoUsd,
      sumaVerificadoUsd,
      // Sin datos todavía: nunca se muestra un "$0.00" fabricado, sino la ausencia
      // explícita de eventos (REQ-UX-002, mismo criterio que el resto del frontend).
      sinDatos: eventos.length === 0,
      supuestoVersion,
      supuestoUrl: "/docs/referencia/03-investigacion-H12-H21.md#h17--economia-del-hotel-independiente-y-modelo-de-roi-por-agente",
    });
  });

  return app;
}
