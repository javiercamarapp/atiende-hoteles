// H6b · /hoteles/:hotelId/aprobaciones — bandeja persistente de `agent_approval`
// (ADR-006/GOB-026): listar pendientes, aprobar/rechazar con motivo (texto exacto que ve
// el aprobador, auditable), y EJECUTAR la tool de dominio correspondiente en el momento en
// que la solicitud llega a "aprobada" (fuera de una corrida de `AgentRunner`: dos
// peticiones HTTP separadas de dos aprobadores distintos, en el caso de dinero). RLS
// (0042_agent_approval.sql) ya restringe decidir a owner/gm; `assertRole` es la segunda
// capa explícita, igual que el resto de la API.
import { Hono } from "hono";
import { z } from "zod";
import { decidirYEjecutarAprobacion } from "../lib/aprobacionEjecutor.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// backend ALTO (auditoria-2): `role` NUNCA se acepta del cliente -- GOB-026 exige DOS
// ROLES DISTINTOS reales para la doble confirmación de dinero; si el cliente pudiera
// mandar su propio `role`, dos personas con el MISMO rol real (p.ej. dos co-propietarios
// "owner") podrían mentir sobre su rol y auto-aprobar un gasto grande sin la segunda
// jerarquía real que la regla busca. El rol SIEMPRE sale de `c.get("hotelRole")`
// (resuelto por `requireHotelMembership` desde `hotel_staff`, nunca del body).
const decidirSchema = z
  .object({
    decision: z.enum(["aprobar", "rechazar"]),
    textoExacto: z.string().trim().min(1).max(1000),
  })
  .strict();

interface ApprovalRow {
  id: string;
  tool_name: string;
  texto_mostrado: string;
  input_summary: string;
  requested_by: string;
  is_money: boolean;
  required_confirmations: number;
  status: string;
  requested_at: string;
  expires_at: string;
}

interface ConfirmationRow {
  actor: string;
  role: string | null;
  decision: string;
  texto_exacto: string;
  decided_at: string;
}

export function aprobacionesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/aprobaciones*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/aprobaciones", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const estado = c.req.query("estado");

    const { rows } = await db.query<ApprovalRow>(
      `select id, tool_name, texto_mostrado, input_summary, requested_by, is_money,
              required_confirmations, status, requested_at::text as requested_at, expires_at::text as expires_at
       from public.agent_approval
       where hotel_id = $1 and ($2::text is null or status = $2::public.agent_approval_status)
       order by requested_at desc
       limit 200;`,
      [hotelId, estado ?? null],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        tool: r.tool_name,
        textoMostrado: r.texto_mostrado,
        resumenInput: r.input_summary,
        solicitadoPor: r.requested_by,
        esDinero: r.is_money,
        confirmacionesRequeridas: r.required_confirmations,
        estado: r.status,
        solicitadoEn: r.requested_at,
        expiraEn: r.expires_at,
      })),
    );
  });

  app.get("/hoteles/:hotelId/aprobaciones/:id", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<ApprovalRow>(
      `select id, tool_name, texto_mostrado, input_summary, requested_by, is_money,
              required_confirmations, status, requested_at::text as requested_at, expires_at::text as expires_at
       from public.agent_approval where id = $1 and hotel_id = $2;`,
      [c.req.param("id"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Solicitud de aprobación no encontrada.");
    const { rows: confirmations } = await db.query<ConfirmationRow>(
      `select actor, role, decision, texto_exacto, decided_at::text as decided_at
       from public.agent_approval_confirmation
       where approval_id = $1
       order by decided_at asc;`,
      [c.req.param("id")],
    );

    const r = rows[0]!;
    return c.json({
      id: r.id,
      tool: r.tool_name,
      textoMostrado: r.texto_mostrado,
      resumenInput: r.input_summary,
      solicitadoPor: r.requested_by,
      esDinero: r.is_money,
      confirmacionesRequeridas: r.required_confirmations,
      estado: r.status,
      solicitadoEn: r.requested_at,
      expiraEn: r.expires_at,
      confirmaciones: confirmations.map((cf) => ({
        actor: cf.actor,
        rol: cf.role,
        decision: cf.decision,
        textoExacto: cf.texto_exacto,
        decididoEn: cf.decided_at,
      })),
    });
  });

  app.post("/hoteles/:hotelId/aprobaciones/:id/decidir", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const approvalId = c.req.param("id");
    const body = parseBody(decidirSchema, await c.req.json().catch(() => ({})));

    // Misma lógica de negocio (decidir + ejecutar la tool si queda aprobada) que
    // routes/aprobacionesWhatsapp.ts (REQ-UX-006, botón de WhatsApp) -- ver
    // lib/aprobacionEjecutor.ts.
    const resultado = await decidirYEjecutarAprobacion({
      db,
      hotelId,
      approvalId,
      actor: c.get("userId"),
      role: c.get("hotelRole"),
      decision: body.decision,
      textoExacto: body.textoExacto,
      requestId: c.get("requestId"),
    });

    return c.json(resultado);
  });

  return app;
}
