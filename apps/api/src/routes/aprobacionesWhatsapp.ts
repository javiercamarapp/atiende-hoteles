// REQ-UX-006 (H09-026/BP-010): "Las aprobaciones operativas del gerente ... deben
// poder ejecutarse mediante botón directamente en el mensaje de WhatsApp, sin
// requerir acceso al panel web." Webhook PÚBLICO (Meta no manda sesión de staff),
// mismo criterio de verificación que routes/mensajeria.ts (HMAC contra el
// `webhook_secret` del hotel, idempotencia persistente por `event_id`). El actor real
// (quién aprobó) se resuelve por el número de WhatsApp remitente contra
// `staff_user.whatsapp_phone` (migración 0053) -- nunca por un JWT, porque
// deliberadamente no existe ninguno en este camino.
//
// La decisión en sí reutiliza EXACTAMENTE la misma lógica que el endpoint autenticado
// del panel web (lib/aprobacionEjecutor.ts) -- un botón de WhatsApp nunca es un camino
// "más permisivo" que el panel, solo un canal distinto para el mismo owner/gm.
import { Hono } from "hono";
import { WebhookReplayError, WebhookSignatureError } from "@atiende-hoteles/mcp-shared";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { decidirYEjecutarAprobacion } from "../lib/aprobacionEjecutor.ts";
import { Errors } from "../lib/errors.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const BUTTON_ID_PATTERN = /^(aprobar|rechazar):(.+)$/;

export function aprobacionesWhatsappRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.post("/hoteles/:hotelId/aprobaciones/webhook", async (c) => {
    const hotelId = c.req.param("hotelId");
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? c.req.header("x-webhook-signature");

    const { rows: configRows } = await deps.engine.admin.query<{ webhook_secret: string; tenant_id: string }>(
      "select webhook_secret, tenant_id from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    if (!configRows[0]) throw Errors.notFound("Este hotel no tiene mensajería configurada.");

    const adapter = new FakeWhatsappAdapter(undefined, undefined, configRows[0].webhook_secret);
    let event;
    try {
      event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureError) throw Errors.unauthorized("Firma de webhook inválida.");
      if (err instanceof WebhookReplayError) return c.json({ estado: "duplicado" }, 200);
      throw err;
    }

    if (event.type !== "interactive.button_clicked" || !event.buttonId || !event.from) {
      // Este webhook comparte el mismo canal/secreto que mensajeria.ts pero solo le
      // interesan los clics de botón -- cualquier otro tipo de evento simplemente no
      // es asunto suyo, se reconoce sin error.
      return c.json({ estado: "ignorado" }, 200);
    }

    const match = BUTTON_ID_PATTERN.exec(event.buttonId);
    if (!match) throw Errors.validation(`buttonId con formato inesperado: "${event.buttonId}".`);
    const decision = match[1] === "aprobar" ? "aprobar" : "rechazar";
    const approvalId = match[2]!;

    const { rows: staffRows } = await deps.engine.admin.query<{ id: string; role: HotelRole }>(
      `select su.id, hs.role
       from public.staff_user su
       join public.hotel_staff hs on hs.user_id = su.id and hs.hotel_id = $2
       where su.whatsapp_phone = $1;`,
      [event.from, hotelId],
    );
    const staff = staffRows[0];
    if (!staff || !ADMIN_ROLES.includes(staff.role)) {
      throw Errors.forbidden("El número de WhatsApp remitente no corresponde a un owner/gm de este hotel.");
    }

    // backend ALTO (auditoria-2): la reclamación de idempotencia (`insert into
    // idempotency_key`) y el efecto real (decidir + ejecutar la tool aprobada) ahora
    // viven en la MISMA transacción (`withAppSession`), no en dos escrituras
    // separadas -- antes, la reclamación se comiteaba de inmediato sobre
    // `engine.admin` (autocommiteada, fuera de cualquier transacción) y el efecto se
    // ejecutaba DESPUÉS en una transacción nueva e independiente. Un crash del
    // proceso entre ambas dejaba el evento "reclamado" (consumido) sin que la
    // aprobación se hubiera decidido -- un reintento de Meta con el mismo `event_id`
    // entraba directo a "duplicado" sin volver a intentar el efecto real, perdiendo
    // el clic del owner en silencio. Con ambas escrituras en la misma transacción,
    // si el proceso muere a medio camino, Postgres revierte TODO (incluida la
    // reclamación) -- un reintento de Meta vuelve a encontrar el evento libre y sí
    // reintenta el efecto real. `withAppSession` fija auth.uid()=staff.id (ADR-004):
    // la RLS real de agent_approval/hotel_staff evalúa exactamente la misma
    // membresía que evaluaría si este mismo owner/gm hubiera llamado el endpoint
    // autenticado del panel web.
    const resultado = await deps.engine.withAppSession({ userId: staff.id }, async (session) => {
      const claim = await session.query<{ id: string }>(
        `insert into public.idempotency_key (tenant_id, scope, key)
         values ($1, 'whatsapp.aprobacion_webhook', $2)
         on conflict (tenant_id, scope, key) do nothing
         returning id;`,
        [configRows[0]!.tenant_id, event.eventId],
      );
      if (claim.rows.length === 0) return { duplicado: true as const };

      const decidido = await decidirYEjecutarAprobacion({
        db: session,
        hotelId,
        approvalId,
        actor: staff.id,
        role: staff.role,
        decision,
        textoExacto: `Decidido por botón de WhatsApp (${event.from}).`,
        requestId: c.get("requestId"),
      });
      return { duplicado: false as const, decidido };
    });

    if (resultado.duplicado) return c.json({ estado: "duplicado" }, 200);
    return c.json(resultado.decidido, 200);
  });

  return app;
}
