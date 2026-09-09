// H16-014 · /hoteles/:hotelId/fraude: POST .../escaneos dispara la detección de los 4
// patrones de fraude interno de REQ-REC-014 (P1/SEG) cruzando PMS+POS y persiste
// cualquier hallazgo NUEVO como alerta (idempotente por hallazgo, ver
// migrations/0095_fraude_alerta.sql); GET .../alertas lista lo ya detectado.
//
// Solo owner/gm/accountant pueden DISPARAR un escaneo -- acción administrativa, mismo
// criterio que `NIGHT_AUDIT_ROLES` de routes/night-audit.ts. fnb puede además
// CONSULTAR sus propias alertas (`cargo_fnb_no_posteado`, su función operativa) -- la
// RLS de packages/db es la autoridad final de ese recorte por patrón; el `assertRole`
// de aquí es defensa en profundidad, no la única barrera.
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import { recipientRolesForPattern, type FraudPattern } from "@atiende-hoteles/domain-hotel";
import { persistFraudFindings, scanFraudSignals } from "../pms/fraudScan.ts";
import { dispatchFraudAlert, resolveFraudAlertDestination } from "../lib/fraudAlertDispatch.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const FRAUD_SCAN_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];
const FRAUD_VIEW_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant", "fnb"];

const scanSchema = z.object({
  // H16-014/ADR-007: sin integración POS real todavía -- una venta F&B reportada
  // llega EXPLÍCITA en el cuerpo de la solicitud (hoy: captura manual/futuro import;
  // nunca esta ruta inventa una integración que no existe). Omitible: sin ventas
  // reportadas, el patrón "cargo_fnb_no_posteado" simplemente no genera hallazgos.
  posSales: z
    .array(
      z.object({
        posSaleId: z.string().trim().min(1).max(120),
        folioId: z.string().uuid(),
        monto: z.number().positive(),
      }),
    )
    .max(200)
    .optional()
    .default([]),
});

/** Resuelve los destinatarios reales (staff del hotel con alguno de `roles`) --
 *  SIEMPRE se llama con `roles` provenientes de `recipientRolesForPattern` (un switch
 *  cerrado sobre un enum propio, nunca del cuerpo de la solicitud): los placeholders
 *  posicionales igual mantienen la consulta parametrizada de principio a fin. */
async function resolveRecipients(
  db: DbClient,
  hotelId: string,
  roles: readonly string[],
): Promise<{ userId: string; email: string; role: string }[]> {
  if (roles.length === 0) return [];
  const placeholders = roles.map((_, i) => `$${i + 2}`).join(",");
  const { rows } = await db.query<{ user_id: string; email: string; role: string }>(
    `select hs.user_id, su.email, hs.role
     from public.hotel_staff hs
     join public.staff_user su on su.id = hs.user_id
     where hs.hotel_id = $1 and hs.role = any(array[${placeholders}]::public.hotel_role[]);`,
    [hotelId, ...roles],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
}

export function fraudeRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/fraude/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/fraude/escaneos", async (c) => {
    assertRole(c, FRAUD_SCAN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(scanSchema, await c.req.json().catch(() => ({})));

    const findings = await scanFraudSignals(db, {
      tenantId: orgId,
      hotelId,
      posSales: body.posSales.map((s) => ({ posSaleId: s.posSaleId, folioId: s.folioId, amount: s.monto })),
    });
    const persisted = await persistFraudFindings(db, { tenantId: orgId, hotelId }, findings);

    const destination = resolveFraudAlertDestination();
    const alertas = [];
    for (const item of persisted) {
      const roles = recipientRolesForPattern(item.finding.pattern);

      // Solo un hallazgo NUEVO (nunca alertado antes, `is_new` de record_fraud_alert)
      // dispara auditoría/outbox/notificación -- un re-escaneo del mismo hallazgo no
      // debe reenviar la misma alerta una y otra vez.
      if (item.isNew) {
        const recipients = await resolveRecipients(db, hotelId, roles);
        await db.query("select public.record_audit_log($1, $2, 'fraud_alert.created', 'fraud_alert', $3, $4);", [
          orgId,
          hotelId,
          item.id,
          JSON.stringify({ patron: item.finding.pattern, folioId: item.finding.folioId, cargoId: item.finding.chargeId, pagoId: item.finding.paymentId }),
        ]);
        await db.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, 'fraud_alert', $3, 'fraude.alerta_generada', $4);`,
          [
            orgId,
            hotelId,
            item.id,
            JSON.stringify({
              patron: item.finding.pattern,
              folioId: item.finding.folioId,
              rolesDestinatario: roles,
              destinatarios: recipients,
            }),
          ],
        );
        // Entrega best-effort (nunca lanza, ver moneyAlert.ts) al canal genérico
        // configurado -- se espera (no `void`) porque este endpoint EXISTE para
        // generar la alerta, a diferencia del middleware de errores que no debe
        // bloquear la respuesta de un request ajeno ya fallido.
        await dispatchFraudAlert(
          {
            nivel: "alerta",
            tipo: "fraude_interno_detectado",
            alerta_id: item.id,
            patron: item.finding.pattern,
            hotel_id: hotelId,
            folio_id: item.finding.folioId,
            charge_id: item.finding.chargeId,
            payment_id: item.finding.paymentId,
            razon: item.finding.reason,
            roles_destinatario: roles,
            destinatarios: recipients.map((r) => r.email),
          },
          destination,
          { logger: deps.logger },
        );
      }

      alertas.push({
        id: item.id,
        esNueva: item.isNew,
        patron: item.finding.pattern,
        folioId: item.finding.folioId,
        cargoId: item.finding.chargeId,
        pagoId: item.finding.paymentId,
        razon: item.finding.reason,
        evidencia: item.finding.evidence,
        rolesDestinatario: roles,
      });
    }

    return c.json(
      { alertas, generadas: alertas.filter((a) => a.esNueva).length, yaExistentes: alertas.filter((a) => !a.esNueva).length },
      200,
    );
  });

  app.get("/hoteles/:hotelId/fraude/alertas", async (c) => {
    assertRole(c, FRAUD_VIEW_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows } = await db.query<{
      id: string;
      pattern: FraudPattern;
      folio_id: string | null;
      charge_id: string | null;
      payment_id: string | null;
      reason: string;
      evidence: unknown;
      recipient_roles: unknown;
      created_at: string;
    }>(
      `select id, pattern, folio_id, charge_id, payment_id, reason, evidence, recipient_roles, created_at::text as created_at
       from public.fraud_alert
       where hotel_id = $1
       order by created_at desc
       limit 200;`,
      [hotelId],
    );

    // La RLS (migrations/0095) ya recorta las filas de `cargo_fnb_no_posteado` a
    // solo owner/gm/accountant/fnb -- esta consulta no filtra por rol a mano, para
    // que ese recorte NUNCA se desincronice de la autoridad real.
    return c.json(
      rows.map((r) => ({
        id: r.id,
        patron: r.pattern,
        folioId: r.folio_id,
        cargoId: r.charge_id,
        pagoId: r.payment_id,
        razon: r.reason,
        evidencia: r.evidence,
        rolesDestinatario: r.recipient_roles,
        creadoEn: r.created_at,
      })),
    );
  });

  return app;
}
