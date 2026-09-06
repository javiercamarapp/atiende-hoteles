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
import type { DbClient } from "@atiende-hoteles/db";

const delegadoSchema = z.object({ userId: z.string().uuid() }).strict();

/** A6 (auditoria-2 agentico ALTO, GOB-026): un hotel con un SOLO owner/gm no puede
 *  completar nunca una aprobación de dinero (exige dos ROLES distintos) -- el owner/gm
 *  único puede designar a otro miembro real del staff (`hotel_approval_delegate`,
 *  migración 0075) como segundo aprobador. El rol REAL del delegado (housekeeping,
 *  frontdesk, lo que sea) ya es distinto del owner/gm que dio la primera confirmación,
 *  así que `decide()` sigue exigiendo roles distintos sin ninguna excepción -- esto
 *  solo decide QUIÉN puede llamar a este endpoint además de ADMIN_ROLES. */
async function isApprovalDelegate(db: DbClient, hotelId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    "select exists(select 1 from public.hotel_approval_delegate where hotel_id = $1 and user_id = $2) as exists;",
    [hotelId, userId],
  );
  return rows[0]?.exists ?? false;
}

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

  // A6: gestión del segundo aprobador delegado (solo owner/gm) -- default SIN
  // delegado, documentado explícitamente: un hotel de un solo administrador debe
  // designar uno para poder completar aprobaciones de dinero. Registrado ANTES de
  // "/aprobaciones/:id" -- Hono, si no, tomaría "delegado" como el `:id`.
  app.get("/hoteles/:hotelId/aprobaciones/delegado", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ user_id: string; full_name: string; created_at: string }>(
      `select d.user_id, su.full_name, d.created_at::text as created_at
       from public.hotel_approval_delegate d
       join public.staff_user su on su.id = d.user_id
       where d.hotel_id = $1;`,
      [c.req.param("hotelId")],
    );
    if (rows.length === 0) return c.json({ delegado: null });
    return c.json({ delegado: { userId: rows[0]!.user_id, nombre: rows[0]!.full_name, designadoEn: rows[0]!.created_at } });
  });

  app.put("/hoteles/:hotelId/aprobaciones/delegado", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(delegadoSchema, await c.req.json().catch(() => ({})));

    const { rows: membershipRows } = await db.query<{ role: string }>(
      "select role from public.hotel_staff where hotel_id = $1 and user_id = $2;",
      [hotelId, body.userId],
    );
    if (membershipRows.length === 0) {
      throw Errors.validation("El delegado debe ser un miembro del staff de este hotel.");
    }

    await db.query(
      `insert into public.hotel_approval_delegate (hotel_id, org_id, user_id, designated_by)
       values ($1, $2, $3, $4)
       on conflict (hotel_id) do update set user_id = excluded.user_id, designated_by = excluded.designated_by, updated_at = now();`,
      [hotelId, orgId, body.userId, c.get("userId")],
    );
    await db.query("select public.record_audit_log($1, $2, 'aprobacion.delegado_designado', 'hotel', $3, $4);", [
      orgId,
      hotelId,
      hotelId,
      JSON.stringify({ userId: body.userId, designadoPor: c.get("userId") }),
    ]);

    return c.json({ ok: true });
  });

  app.delete("/hoteles/:hotelId/aprobaciones/delegado", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    await db.query("delete from public.hotel_approval_delegate where hotel_id = $1;", [hotelId]);
    await db.query("select public.record_audit_log($1, $2, 'aprobacion.delegado_revocado', 'hotel', $3, $4);", [
      orgId,
      hotelId,
      hotelId,
      JSON.stringify({ revocadoPor: c.get("userId") }),
    ]);
    return c.json({ ok: true });
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
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const approvalId = c.req.param("id");

    // A6: además de ADMIN_ROLES (owner/gm), el delegado designado del hotel también
    // puede decidir -- ver `hotel_approval_delegate` (migración 0075). Sin delegado
    // configurado, el comportamiento es idéntico al de antes (solo ADMIN_ROLES).
    const role = c.get("hotelRole");
    const esAdmin = (ADMIN_ROLES as string[]).includes(role);
    if (!esAdmin && !(await isApprovalDelegate(db, hotelId, c.get("userId")))) {
      assertRole(c, ADMIN_ROLES); // lanza 403 con el mensaje estándar
    }

    const body = parseBody(decidirSchema, await c.req.json().catch(() => ({})));

    // Misma lógica de negocio (decidir + ejecutar la tool si queda aprobada) que
    // routes/aprobacionesWhatsapp.ts (REQ-UX-006, botón de WhatsApp) -- ver
    // lib/aprobacionEjecutor.ts. `role` sigue siendo SIEMPRE el real de sesión (el
    // delegado decide con su PROPIO rol real, nunca uno inventado).
    const resultado = await decidirYEjecutarAprobacion({
      db,
      hotelId,
      approvalId,
      actor: c.get("userId"),
      role,
      decision: body.decision,
      textoExacto: body.textoExacto,
      requestId: c.get("requestId"),
    });

    return c.json(resultado);
  });

  return app;
}
