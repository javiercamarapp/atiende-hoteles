// Patrón Likida/atiende.ai #7 ("onboarding conversacional con guardas deterministas"):
// hasta este archivo, el ÚNICO onboarding de un hotel nuevo era el wizard rígido de 3
// pasos fijos de `apps/web/src/pages/Onboarding.tsx` (formularios que llaman
// `POST /hoteles/:hotelId/onboarding/tipos-habitacion`,
// `PATCH /hoteles/:hotelId/onboarding/zona-horaria` en `apps/api/src/routes/
// registro.ts`, y `POST /hoteles/:hotelId/staff/invitaciones` en
// `apps/api/src/routes/correo.ts`) -- sin ningún agente conversacional que haga
// preguntas de seguimiento dinámicas cuando falta información. Estas 4 tools (3 de
// escritura + 1 de lectura de estado) son la base del nuevo agente
// `onboarding_conversacional` (agents.ts): las 3 de escritura reproducen EXACTAMENTE la
// misma lógica SQL que esas rutas HTTP ya probadas (mismo criterio "copia intencional"
// que `ticketTools.ts` -- agent-core sigue sin depender de domain-hotel/apps-api, H6a),
// y la de lectura (`consultar_estado_onboarding`) es lo que
// `requiredCompletionCheck`/`completionStatusGuard.ts` usan para decidir si el agente
// puede cerrar el turno como "completado" -- ver `AgentRunnerOptions.completionStatusToolName`
// en runner.ts.
//
// `Onboarding.tsx` (el wizard estructurado) se mantiene intacto como fallback -- este
// agente es una superficie ADICIONAL, no un reemplazo.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import type { SqlClient } from "../sql.ts";

export const GUARDAR_TIPO_HABITACION_ONBOARDING_TOOL = "guardar_tipo_habitacion_onboarding";
export const GUARDAR_ZONA_HORARIA_ONBOARDING_TOOL = "guardar_zona_horaria_onboarding";
export const INVITAR_STAFF_ONBOARDING_TOOL = "invitar_staff_onboarding";
export const CONSULTAR_ESTADO_ONBOARDING_TOOL = "consultar_estado_onboarding";

// Mismo horizonte que `apps/api/src/routes/registro.ts::ONBOARDING_RATE_HORIZON_DAYS`
// (verificado igual en ambos paquetes por
// tests/unit/agent-core/onboarding-tools.spec.ts, mismo criterio que
// `DEFAULT_SLA_MINUTES_BY_PRIORITY` en ticketTools.ts).
export const ONBOARDING_RATE_HORIZON_DAYS = 30;

export const HOTEL_ROLES_FOR_INVITATION = [
  "owner",
  "gm",
  "frontdesk",
  "reservations",
  "housekeeping",
  "maintenance",
  "fnb",
  "accountant",
] as const;

export interface OnboardingToolDeps {
  readonly db: SqlClient;
}

// ── guardar_tipo_habitacion_onboarding ────────────────────────────────────────────

const tipoHabitacionInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  maxOccupancy: z.number().int().min(1).max(20).default(2),
  totalRooms: z.number().int().min(1).max(500),
  basePrice: z.number().min(0),
});
export type GuardarTipoHabitacionOnboardingInput = z.infer<typeof tipoHabitacionInputSchema>;

export function createGuardarTipoHabitacionOnboardingTool(deps: OnboardingToolDeps): ToolDefinition<GuardarTipoHabitacionOnboardingInput> {
  return defineTool({
    name: GUARDAR_TIPO_HABITACION_ONBOARDING_TOOL,
    description:
      "Registra un tipo de habitación con su tarifa base durante el onboarding de un hotel nuevo (crea el inventario " +
      "de habitaciones + tarifa/disponibilidad para los próximos 30 días).",
    inputSchema: tipoHabitacionInputSchema,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      const { rows: rtRows } = await deps.db.query<{ id: string }>(
        "insert into public.room_type (tenant_id, hotel_id, name, max_occupancy) values ($1, $2, $3, $4) returning id;",
        [ctx.orgId, ctx.hotelId, input.name, input.maxOccupancy],
      );
      const roomTypeId = rtRows[0]!.id;

      for (let i = 1; i <= input.totalRooms; i += 1) {
        const code = `${input.name.slice(0, 3).toUpperCase()}-${i}`;
        await deps.db.query("insert into public.room (tenant_id, hotel_id, room_type_id, code) values ($1, $2, $3, $4);", [
          ctx.orgId,
          ctx.hotelId,
          roomTypeId,
          code,
        ]);
      }

      for (let day = 0; day < ONBOARDING_RATE_HORIZON_DAYS; day += 1) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() + day);
        const isoDate = date.toISOString().slice(0, 10);
        await deps.db.query(
          "insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price) values ($1, $2, $3, $4, $5);",
          [ctx.orgId, ctx.hotelId, roomTypeId, isoDate, input.basePrice],
        );
        await deps.db.query(
          "insert into public.availability (tenant_id, hotel_id, room_type_id, date, total_rooms) values ($1, $2, $3, $4, $5);",
          [ctx.orgId, ctx.hotelId, roomTypeId, isoDate, input.totalRooms],
        );
      }

      await deps.db.query("select public.record_audit_log($1, $2, 'room_type.created_onboarding', 'room_type', $3, $4);", [
        ctx.orgId,
        ctx.hotelId,
        roomTypeId,
        JSON.stringify({ name: input.name, totalRooms: input.totalRooms, basePrice: input.basePrice }),
      ]);

      return {
        ok: true,
        summary: `Tipo de habitación "${input.name}" registrado (${input.totalRooms} habitaciones, tarifa base ${input.basePrice}).`,
        data: { roomTypeId, name: input.name },
      };
    },
  });
}

// ── guardar_zona_horaria_onboarding ───────────────────────────────────────────────

const zonaHorariaInputSchema = z.object({
  // Mismo chequeo de forma que registro.ts/migración 0023 ("Continente/Ciudad" IANA).
  timezone: z.string().trim().regex(/^[A-Za-z_]+\/[A-Za-z_/]+$/, "Debe ser una zona horaria IANA, p. ej. America/Cancun."),
});
export type GuardarZonaHorariaOnboardingInput = z.infer<typeof zonaHorariaInputSchema>;

export function createGuardarZonaHorariaOnboardingTool(deps: OnboardingToolDeps): ToolDefinition<GuardarZonaHorariaOnboardingInput> {
  return defineTool({
    name: GUARDAR_ZONA_HORARIA_ONBOARDING_TOOL,
    description: "Registra la zona horaria IANA del hotel durante el onboarding (p.ej. America/Cancun).",
    inputSchema: zonaHorariaInputSchema,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      await deps.db.query("update public.hotel set timezone = $1 where id = $2;", [input.timezone, ctx.hotelId]);
      await deps.db.query("select public.record_audit_log($1, $2, 'hotel.timezone_updated', 'hotel', $2, $3);", [
        ctx.orgId,
        ctx.hotelId,
        JSON.stringify({ timezone: input.timezone }),
      ]);
      return { ok: true, summary: `Zona horaria registrada: ${input.timezone}.`, data: { timezone: input.timezone } };
    },
  });
}

// ── invitar_staff_onboarding ──────────────────────────────────────────────────────

const invitarStaffInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(HOTEL_ROLES_FOR_INVITATION),
});
export type InvitarStaffOnboardingInput = z.infer<typeof invitarStaffInputSchema>;

/** Contrato mínimo de envío de correo que esta tool necesita -- mismo criterio que
 *  `WhatsappSenderLike` (messagingTools.ts): duck typing estructural, agent-core sigue
 *  sin depender de `@atiende-hoteles/email`. Opcional: sin `email` inyectado, la
 *  invitación SÍ se crea en base de datos (el dato que importa para el guard de
 *  completitud) pero no se envía correo -- mismo espíritu "esqueleto honesto" que
 *  `TicketToolDeps.messaging` opcional. */
export interface EmailSenderLike {
  send(input: { to: string; subject: string; text: string; dedupeKey: string; tenantId: string; hotelId: string }): Promise<unknown>;
}

export interface InvitarStaffOnboardingDeps extends OnboardingToolDeps {
  readonly email?: EmailSenderLike;
  /** Para construir la URL de invitación en el cuerpo del correo -- p.ej.
   *  `https://app.atiende-hoteles.com`. Sin esto (o sin `email`), no se intenta enviar. */
  readonly frontendUrl?: string;
  /** Generador de token inyectable SOLO para pruebas deterministas -- default
   *  `randomBytes(32).toString('hex')` (MISMO formato que correo.ts `generarToken()`). */
  readonly generateToken?: () => string;
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

const INVITATION_TTL_DAYS = 7;

export function createInvitarStaffOnboardingTool(deps: InvitarStaffOnboardingDeps): ToolDefinition<InvitarStaffOnboardingInput> {
  return defineTool({
    name: INVITAR_STAFF_ONBOARDING_TOOL,
    description: "Invita a un miembro de staff por correo con un rol asignado, durante el onboarding de un hotel nuevo.",
    inputSchema: invitarStaffInputSchema,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      await deps.db.query(
        "update public.account_token set status = 'expirado' where hotel_id = $1 and purpose = 'invitacion_staff' and lower(email) = $2 and status = 'pendiente';",
        [ctx.hotelId, input.email],
      );

      const token = (deps.generateToken ?? defaultGenerateToken)();
      await deps.db.query(
        `insert into public.account_token (purpose, org_id, hotel_id, email, role, token, expires_at)
         values ('invitacion_staff', $1, $2, $3, $4, $5, now() + interval '${INVITATION_TTL_DAYS} days');`,
        [ctx.orgId, ctx.hotelId, input.email, input.role, token],
      );

      let correoEnviado = false;
      if (deps.email && deps.frontendUrl) {
        const invitationUrl = new URL("/registro/invitacion", deps.frontendUrl);
        invitationUrl.searchParams.set("token", token);
        await deps.email.send({
          to: input.email,
          subject: "Te invitaron a un equipo en Atiende Hoteles",
          text: `Te invitaron con el rol "${input.role}". Acepta aquí: ${invitationUrl.toString()} (expira en ${INVITATION_TTL_DAYS} días).`,
          dedupeKey: `invitacion-staff:${ctx.hotelId}:${input.email}:${token}`,
          tenantId: ctx.orgId,
          hotelId: ctx.hotelId,
        });
        correoEnviado = true;
      }

      return {
        ok: true,
        summary: correoEnviado
          ? `Invitación enviada a ${input.email} (rol ${input.role}).`
          : `Invitación registrada para ${input.email} (rol ${input.role}); sin adaptador de correo configurado, no se envió el correo real.`,
        data: { email: input.email, role: input.role, correoEnviado },
      };
    },
  });
}

// ── consultar_estado_onboarding (lectura, base del guard de completitud) ─────────

/** Shape que `completionStatusGuard.ts` (runner.ts) espera en `ToolResult.data` --
 *  contrato compartido, ver ese archivo. */
export interface OnboardingCompletionStatus {
  readonly completo: boolean;
  readonly camposFaltantes: readonly string[];
}

const consultarEstadoInputSchema = z.object({});
export type ConsultarEstadoOnboardingInput = z.infer<typeof consultarEstadoInputSchema>;

export function createConsultarEstadoOnboardingTool(deps: OnboardingToolDeps): ToolDefinition<ConsultarEstadoOnboardingInput> {
  return defineTool({
    name: CONSULTAR_ESTADO_ONBOARDING_TOOL,
    description:
      "Consulta qué pasos del onboarding de este hotel ya están completos (tipo de habitación, zona horaria, invitación " +
      "de equipo) y cuáles faltan. Llamar SIEMPRE antes de dar el onboarding por terminado.",
    inputSchema: consultarEstadoInputSchema,
    effect: "read",
    needsApproval: false,
    run: async (ctx) => {
      // Secuencial (nunca Promise.all sobre `deps.db`): la sesión inyectada suele ser
      // UN solo cliente `pg` por transacción (`withAppSession`, packages/db/src/engines.ts)
      // -- lanzar varias queries concurrentes sobre el mismo cliente no es paralelo de
      // verdad (el driver las serializa igual) y `pg` emite una advertencia de API
      // obsoleta al respecto.
      const roomTypes = await deps.db.query<{ count: string }>(
        "select count(*)::text as count from public.room_type where hotel_id = $1;",
        [ctx.hotelId],
      );
      // `hotel.timezone` (migración 0023) tiene DEFAULT 'America/Mexico_City' -- nunca
      // es null, así que no sirve por sí solo para distinguir "el dueño todavía no lo
      // confirmó" de "sí lo confirmó (aunque coincida con el default)". La señal real
      // es que exista al menos una fila de auditoría `hotel.timezone_updated`
      // (`record_audit_log`, la MISMA que esta tool y `registro.ts` PATCH dejan al
      // guardar) -- confirmación EXPLÍCITA, nunca el valor por defecto de la columna.
      const zonaHorariaConfirmada = await deps.db.query<{ count: string }>(
        "select count(*)::text as count from public.audit_log where hotel_id = $1 and action = 'hotel.timezone_updated';",
        [ctx.hotelId],
      );
      const invitaciones = await deps.db.query<{ count: string }>(
        "select count(*)::text as count from public.account_token where hotel_id = $1 and purpose = 'invitacion_staff';",
        [ctx.hotelId],
      );

      const tieneTipoHabitacion = Number(roomTypes.rows[0]?.count ?? 0) > 0;
      const tieneZonaHoraria = Number(zonaHorariaConfirmada.rows[0]?.count ?? 0) > 0;
      const tieneInvitacion = Number(invitaciones.rows[0]?.count ?? 0) > 0;

      const camposFaltantes: string[] = [];
      if (!tieneTipoHabitacion) camposFaltantes.push("al menos un tipo de habitación con tarifa base");
      if (!tieneZonaHoraria) camposFaltantes.push("la zona horaria del hotel");
      if (!tieneInvitacion) camposFaltantes.push("invitar a al menos un miembro de tu equipo");

      const status: OnboardingCompletionStatus = { completo: camposFaltantes.length === 0, camposFaltantes };
      return {
        ok: true,
        summary: status.completo
          ? "Onboarding completo: los 3 pasos obligatorios ya están registrados."
          : `Onboarding incompleto -- falta: ${camposFaltantes.join("; ")}.`,
        data: status,
      };
    },
  });
}
