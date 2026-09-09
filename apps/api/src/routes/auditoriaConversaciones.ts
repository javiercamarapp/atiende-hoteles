// REQ-HUE-007 · "El sistema debe auditar semanalmente una muestra de
// conversaciones/llamadas (p. ej. 30) para detectar errores del bot (disponibilidad/
// precio erróneo, políticas inventadas, identidad no verificada, idioma incorrecto,
// alucinaciones)."
//
// Dos acciones gerenciales (owner/gm, mismo criterio de "revisión de calidad del
// agente" que ninguna otra ruta de este repo cubre todavía):
//  1) generar/consultar la muestra determinística de la semana (POST idempotente: si
//     la semana ya tiene muestra, la devuelve tal cual sin volver a sortear -- ver
//     `selectWeeklyAuditSample`, @atiende-hoteles/domain-hotel).
//  2) registrar el veredicto de revisión de un ítem de esa muestra.
//
// El universo candidato son conversaciones (`conversation`, 0044) cuyo último mensaje
// cayó dentro de la ventana de 7 días de la semana pedida -- funciona hoy sobre el
// canal WhatsApp simulado (FakeWhatsappAdapter, ADR-007) sin depender de telefonía
// real.
import { Hono } from "hono";
import { z } from "zod";
import {
  CONVERSATION_AUDIT_CATEGORIES,
  ConversationAuditError,
  assertValidAuditReview,
  resolveIsoWeekStart,
  resolveAuditWindow,
  selectWeeklyAuditSample,
  DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const generarMuestraSchema = z.object({
  weekOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sampleSize: z.number().int().positive().max(500).optional(),
});

const revisionSchema = z.object({
  categoria: z.enum(CONVERSATION_AUDIT_CATEGORIES),
  notas: z.string().trim().max(2000).optional(),
});

interface SampleRow {
  id: string;
  conversation_id: string;
  week_of: string;
  sampled_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  category: string | null;
  notes: string | null;
  channel: string | null;
  guest_phone: string | null;
  last_message_at: string | null;
  last_message_body: string | null;
}

function serializeSample(row: SampleRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    semanaDe: row.week_of,
    muestreadoEn: row.sampled_at,
    revisadoEn: row.reviewed_at,
    revisadoPor: row.reviewed_by,
    categoria: row.category,
    notas: row.notes,
    conversacion: {
      canal: row.channel,
      telefonoHuesped: row.guest_phone,
      ultimoMensajeEn: row.last_message_at,
      ultimoMensaje: row.last_message_body,
    },
  };
}

const SAMPLE_SELECT = `
  select cas.id, cas.conversation_id, cas.week_of::text as week_of,
         cas.sampled_at::text as sampled_at, cas.reviewed_at::text as reviewed_at,
         cas.reviewed_by, cas.category::text as category, cas.notes,
         co.channel::text as channel, co.guest_phone,
         co.last_message_at::text as last_message_at,
         (select m.body from public.message m
          where m.conversation_id = co.id
          order by m.created_at desc limit 1) as last_message_body
  from public.conversation_audit_sample cas
  join public.conversation co on co.id = cas.conversation_id
  where cas.hotel_id = $1
`;

export function auditoriaConversacionesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/auditoria-conversaciones/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/auditoria-conversaciones",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // GET: consulta la muestra ya generada de una semana (por defecto, la semana actual)
  // -- no genera nada, solo lee.
  app.get("/hoteles/:hotelId/auditoria-conversaciones", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const weekOfParam = c.req.query("weekOf");
    const weekOf = weekOfParam ?? resolveIsoWeekStart(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) throw Errors.validation("weekOf debe tener formato YYYY-MM-DD.");

    const { rows } = await db.query<SampleRow>(`${SAMPLE_SELECT} and cas.week_of = $2 order by cas.sampled_at asc;`, [
      hotelId,
      weekOf,
    ]);
    return c.json({ semanaDe: weekOf, muestra: rows.map(serializeSample) });
  });

  // POST: genera la muestra de la semana pedida (idempotente -- si ya existe, la
  // devuelve sin re-sortear) a partir de las conversaciones cuyo último mensaje cayó en
  // esa ventana de 7 días.
  app.post("/hoteles/:hotelId/auditoria-conversaciones", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(generarMuestraSchema, await c.req.json().catch(() => ({})));
    const weekOf = body.weekOf ?? resolveIsoWeekStart(new Date());

    let window: { start: Date; end: Date };
    try {
      window = resolveAuditWindow(weekOf);
    } catch (err) {
      if (err instanceof ConversationAuditError) throw Errors.validation(err.message);
      throw err;
    }

    const { rows: existing } = await db.query<SampleRow>(`${SAMPLE_SELECT} and cas.week_of = $2 order by cas.sampled_at asc;`, [
      hotelId,
      weekOf,
    ]);
    if (existing.length > 0) {
      // Ya generada: se devuelve tal cual (idempotencia declarada arriba), nunca se
      // vuelve a sortear ni se agregan/quitan conversaciones a una muestra ya fijada.
      return c.json({ semanaDe: weekOf, muestra: existing.map(serializeSample), yaExistia: true });
    }

    const { rows: candidatos } = await db.query<{ id: string }>(
      `select id from public.conversation
       where hotel_id = $1 and last_message_at >= $2 and last_message_at < $3;`,
      [hotelId, window.start.toISOString(), window.end.toISOString()],
    );
    const candidateIds = candidatos.map((r) => r.id);
    const seleccionados = selectWeeklyAuditSample(candidateIds, {
      seed: `${hotelId}::${weekOf}`,
      sampleSize: body.sampleSize ?? DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE,
    });

    for (const conversationId of seleccionados) {
      await db.query(
        `insert into public.conversation_audit_sample (tenant_id, hotel_id, conversation_id, week_of)
         values ($1, $2, $3, $4)
         on conflict (hotel_id, week_of, conversation_id) do nothing;`,
        [orgId, hotelId, conversationId, weekOf],
      );
    }

    const { rows: creados } = await db.query<SampleRow>(`${SAMPLE_SELECT} and cas.week_of = $2 order by cas.sampled_at asc;`, [
      hotelId,
      weekOf,
    ]);
    return c.json({ semanaDe: weekOf, muestra: creados.map(serializeSample), yaExistia: false }, 201);
  });

  // PATCH: registra el veredicto de revisión de un ítem puntual de la muestra.
  app.patch("/hoteles/:hotelId/auditoria-conversaciones/:sampleId", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const sampleId = c.req.param("sampleId");
    const body = parseBody(revisionSchema, await c.req.json().catch(() => ({})));

    let validated: ReturnType<typeof assertValidAuditReview>;
    try {
      validated = assertValidAuditReview({ category: body.categoria, notes: body.notas });
    } catch (err) {
      if (err instanceof ConversationAuditError) throw Errors.validation(err.message);
      throw err;
    }

    const { rows } = await db.query<{ id: string }>(
      `update public.conversation_audit_sample
       set reviewed_at = now(), reviewed_by = $1, category = $2, notes = $3
       where id = $4 and hotel_id = $5
       returning id;`,
      [c.get("userId"), validated.category, validated.notes, sampleId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Ítem de auditoría no encontrado.");

    await db.query(
      "select public.record_audit_log($1, $2, 'conversation_audit.reviewed', 'conversation_audit_sample', $3, $4);",
      [orgId, hotelId, sampleId, JSON.stringify({ categoria: validated.category })],
    );

    const { rows: actualizado } = await db.query<SampleRow>(`${SAMPLE_SELECT} and cas.id = $2;`, [hotelId, sampleId]);
    return c.json(serializeSample(actualizado[0]!));
  });

  return app;
}
