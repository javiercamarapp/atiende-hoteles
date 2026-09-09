// REQ-SEG-009 (H19-010/BP-153) · "Debe existir un procedimiento documentado y probado de
// notificación de brechas de seguridad (detección, evaluación, notificación al afectado
// y a la autoridad en plazo); una brecha de datos de pasaporte se considera vulneración
// significativa que requiere notificación obligatoria." El procedimiento humano completo
// vive en `docs/runbooks/incidentes.md` §1 -- esta ruta es el mecanismo TÉCNICO real que
// ese runbook referencia para dos de sus pasos:
//   - 1.2 "Preservar evidencia"/1.4.2 "informar internamente sin demora": DECLARAR una
//     brecha aquí deja un registro INMUTABLE (vía `record_audit_log`, misma cadena de
//     hash append-only que ya usa todo el resto del repo, 0008/0012/0015/0016) con la
//     marca de tiempo de detección que dispara el conteo del plazo legal, Y dispara una
//     notificación activa por webhook (lib/securityBreachAlert.ts, mismo patrón ya
//     aceptado para el camino del dinero en ADR-008/moneyAlert.ts) en vez de depender de
//     que alguien esté mirando los logs.
//   - 1.3 "Evaluación de impacto": el propio endpoint calcula
//     `vulneracionSignificativa` con el mismo criterio textual que exige REQ-SEG-009
//     ("una brecha de datos de pasaporte..."), generalizado a cualquier documento de
//     identidad/credencial fiscal (ver `esVulneracionSignificativa`).
//
// LÍMITE EXPLICITO: el CANAL FINAL de notificación AL AFECTADO y a la autoridad (INAI)
// sigue siendo un proceso humano con plazo/plantilla pendientes de asesoría legal (ver
// runbook §1.4.1) -- esta ruta nunca envía nada a un huésped ni a una autoridad por sí
// misma. Lo que SÍ hace, de punta a punta y probado (tests/integration/api/
// incidentes.spec.ts): registrar el incidente de forma inmutable y notificar
// internamente (webhook configurable) sin demora.
import { Hono } from "hono";
import { z } from "zod";
import {
  buildSecurityBreachAlertLog,
  dispatchSecurityBreachAlert,
  esVulneracionSignificativa,
  resolveSecurityBreachAlertDestination,
} from "../lib/securityBreachAlert.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Catálogo cerrado y explícito (mismo criterio que `esVulneracionSignificativa`,
// securityBreachAlert.ts): declarar una categoría nueva es una decisión consciente de
// quien edita este archivo, nunca texto libre sin estructura.
const declararBrechaSchema = z.object({
  categoria: z.enum([
    "documento_identidad",
    "datos_pago",
    "credencial_fiscal",
    "credencial_aplicacion",
    "conversacion_huesped",
    "otro",
  ]),
  descripcion: z.string().trim().min(10).max(2000),
  datosInvolucrados: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});

interface AuditLogRow {
  id: string;
  hotel_id: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

function toIncidenteBody(row: AuditLogRow) {
  const payload = row.payload ?? {};
  return {
    incidenteId: row.id,
    detectadoEn: row.created_at,
    declaradoPor: row.actor_user_id,
    categoria: payload.categoria as string | undefined,
    descripcion: payload.descripcion as string | undefined,
    datosInvolucrados: (payload.datosInvolucrados as string[] | undefined) ?? [],
    vulneracionSignificativa: Boolean(payload.vulneracionSignificativa),
    notificacionEntregada: Boolean(payload.notificacionEntregada),
  };
}

export function incidentesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/incidentes/brecha*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // REQ-SEG-009: declarar una brecha es una decisión de owner/gm (mismo nivel que
  // aprobar la presentación fiscal ante el SAT, REQ-SEG-010/GOB-041) -- nunca un rol
  // operativo sin visibilidad de negocio completa.
  app.post("/hoteles/:hotelId/incidentes/brecha", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    const hotelId = c.req.param("hotelId");
    const requestId = c.get("requestId");
    const body = parseBody(declararBrechaSchema, await c.req.json().catch(() => ({})));

    const vulneracionSignificativa = esVulneracionSignificativa(body.datosInvolucrados);
    const destino = resolveSecurityBreachAlertDestination();
    const notificacionEntregada = Boolean(destino.webhookUrl) || Boolean(destino.emailTo && destino.emailWebhookUrl);

    // record_audit_log (SECURITY DEFINER, 0016) valida que orgId/hotelId coincidan con
    // la membresía real del actor -- misma defensa en profundidad que el resto del
    // repo, aunque `requireHotelMembership` ya lo verificó en vivo arriba. `created_at`
    // de la fila resultante ES la marca de tiempo de detección que dispara el conteo
    // del plazo legal (runbook §1.4.1) -- inmutable, encadenada por hash.
    const { rows } = await db.query<AuditLogRow>(
      `select id, hotel_id, actor_user_id, payload, created_at::text as created_at
       from public.record_audit_log($1, $2, 'security_breach.declared', 'security_breach', null, $3);`,
      [
        orgId,
        hotelId,
        JSON.stringify({
          categoria: body.categoria,
          descripcion: body.descripcion,
          datosInvolucrados: body.datosInvolucrados,
          vulneracionSignificativa,
          notificacionEntregada,
        }),
      ],
    );
    const incidente = rows[0]!;

    // Notificación interna sin demora (runbook §1.4.2) -- fire-and-forget respecto al
    // ciclo de respuesta (mismo criterio que app.ts con dispatchMoneyAlert: un webhook
    // caído nunca debe convertirse en un 5xx de esta ruta), pero SÍ se espera aquí
    // (`await`, no `void`) porque a diferencia del camino del dinero esta ruta no está
    // respondiendo a un error ya ocurrido -- es la propia acción principal, y
    // `dispatchSecurityBreachAlert` nunca lanza (atrapa sus propios fallos).
    const alerta = buildSecurityBreachAlertLog({
      incidentId: incidente.id,
      requestId,
      orgId,
      hotelId,
      actorId: userId,
      categoria: body.categoria,
      descripcion: body.descripcion,
      datosInvolucrados: body.datosInvolucrados,
      vulneracionSignificativa,
      detectadoEn: incidente.created_at,
    });
    await dispatchSecurityBreachAlert(alerta, destino, { logger: deps.logger });
    if (!notificacionEntregada) {
      deps.logger.error(alerta, "brecha_seguridad_sin_destinatario_configurado");
    }

    return c.json(toIncidenteBody(incidente), 201);
  });

  // Traza/listado para auditoría interna (runbook §1.5 "postmortem") -- lee del mismo
  // audit_log inmutable, nunca de una tabla paralela que pudiera desincronizarse.
  app.get("/hoteles/:hotelId/incidentes/brecha", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<AuditLogRow>(
      `select id, hotel_id, actor_user_id, payload, created_at::text as created_at
       from public.audit_log
       where hotel_id = $1 and entity_type = 'security_breach' and action = 'security_breach.declared'
       order by created_at desc;`,
      [hotelId],
    );
    return c.json(rows.map(toIncidenteBody));
  });

  return app;
}
