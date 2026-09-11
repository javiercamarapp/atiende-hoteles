// REQ-CRM-002 (P1/F): /hoteles/:hotelId/reputacion — clasifica automáticamente cada
// reseña/encuesta por TEMA + SENTIMIENTO (incluyendo temas locales no entrenados
// previamente, `@atiende-hoteles/domain-hotel` `clasificarResena`) y dispara la
// acción correspondiente:
//   - ticket_mantenimiento: se EJECUTA de inmediato (reusa `crear_ticket_mantenimiento`
//     de agent-core, la misma tool que usa routes/mantenimiento.ts -- no depende de
//     ninguna integración externa, ADR-007 no aplica aquí).
//   - mensaje_proactivo / compensacion_reglada: quedan en `guest_review_action`
//     `status='pendiente'` para ejecución HUMANA -- enviar WhatsApp real exige una
//     plantilla aprobada de Meta (ver messagingTools.ts) y aplicar una compensación
//     mueve dinero (GOB-026: SIEMPRE aprobación humana). Ninguna de las dos es un
//     "problema de credenciales" de ESTE requisito (por eso su dependencia en
//     REQUISITOS.md es "ninguna"): la clasificación + crear el registro correcto de
//     la acción pendiente no necesitan nada más para quedar completas.
//
// REQ-CRM-001 (el inbox real de Google/Booking/TripAdvisor) sigue
// "pendiente-credenciales": esta ruta clasifica CUALQUIER texto de reseña/encuesta que
// ya llegó al sistema por el canal que sea (hoy, típicamente una encuesta propia
// capturada por frontdesk/reservations), sin fabricar esa integración pendiente.
//
// REQ-CRM-003 (P1/F): además de la acción inmediata de arriba, esta ruta evalúa si
// ALGÚN tema mencionado negativamente en la reseña recién clasificada acumula N
// menciones negativas del MISMO tema dentro de una ventana de tiempo (default 3 en 14
// días, `ACUMULACION_TICKET_DEFAULT`) contando también reseñas ANTERIORES del mismo
// hotel -- y si es así, dispara su propio ticket de mantenimiento automático. Esto
// aporta valor real sobre todo para temas que una sola mención NO amerita ticketear de
// inmediato (cualquier tema fuera de `TICKET_TOPICS`: personal, ubicación, desayuno,
// check-in, precio, seguridad, o un tema local nunca antes visto) -- para los temas que
// SÍ están en `TICKET_TOPICS` (limpieza, wifi, ruido, aire acondicionado, alberca) el
// ticket ya se creó en la primera mención negativa (ver `persistirAcciones` arriba), así
// que la comprobación de "ya existe un ticket reciente" (`yaExisteTicketReciente`) evita
// duplicar el ticket para esos temas. Ver `packages/domain-hotel/src/reputacion/
// acumulacionTickets.ts` para la política pura (fechas adentro, decisión afuera) y por
// qué vive separada de `clasificador.ts`.
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  buildToolContext,
  createMaintenanceTicketTool,
  createRunBudget,
  type CreateMaintenanceTicketInput,
  type OutboundTaskSyncLike,
} from "@atiende-hoteles/agent-core";
import {
  ACUMULACION_TICKET_DEFAULT,
  clasificarResena,
  esSentimientoNegativo,
  evaluarAcumulacionTicket,
  type AccionReputacion,
  type ReviewTopicId,
  type StayState,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const REVIEW_SUBMIT_ROLES: HotelRole[] = [...ADMIN_ROLES, "frontdesk", "reservations"];
const REVIEW_VIEW_ROLES: HotelRole[] = [...ADMIN_ROLES, "frontdesk", "reservations", "accountant"];
const REVIEW_ACTION_RESOLVE_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];

const clasificarResenaSchema = z.object({
  fuente: z.enum(["google", "booking", "tripadvisor", "expedia", "encuesta_propia", "otro"]).default("encuesta_propia"),
  externalId: z.string().trim().min(1).max(200).optional(),
  texto: z.string().trim().min(1).max(4000),
  idioma: z.string().trim().min(2).max(10).default("es"),
  calificacion: z.number().int().min(1).max(5).optional(),
  esPublica: z.boolean().default(true),
  huespedId: z.string().uuid().optional(),
  reservaId: z.string().uuid().optional(),
});

const resolverAccionSchema = z.object({ estado: z.enum(["ejecutada", "descartada"]) });

/** Mapea el estado REAL de la reservación (única fuente de verdad, nunca lo que
 *  declare el cuerpo de la solicitud) al `StayState` que necesita el dominio para
 *  decidir si el mensaje proactivo tiene sentido (solo si el huésped SIGUE en el
 *  hotel). */
function stayStateFromReservationStatus(status: string): StayState {
  if (status === "check_in" || status === "en_estancia") return "en_estancia";
  if (status === "check_out" || status === "cerrada") return "post_estancia";
  return "desconocido";
}

interface AccionPersistida {
  id: string;
  tipo: AccionReputacion["tipo"];
  estado: "pendiente" | "ejecutada" | "descartada";
  ticketId: string | null;
  detalle: Record<string, unknown>;
  razon: string;
}

/** Ejecuta/registra cada acción decidida por el clasificador. El ticket de
 *  mantenimiento se crea DE VERDAD contra `maintenance_ticket` (misma tool que
 *  routes/mantenimiento.ts); las demás quedan `pendiente` para que un humano las
 *  ejecute (ver comentario de archivo). */
async function persistirAcciones(
  db: DbClient,
  ctx: { orgId: string; hotelId: string; userId: string; requestId: string },
  reviewId: string,
  acciones: AccionReputacion[],
  outboundSync: OutboundTaskSyncLike,
): Promise<AccionPersistida[]> {
  const persistidas: AccionPersistida[] = [];

  for (const accion of acciones) {
    if (accion.tipo === "ticket_mantenimiento") {
      const toolCtx = buildToolContext(
        {
          orgId: ctx.orgId,
          hotelId: ctx.hotelId,
          actor: { type: "staff", id: ctx.userId },
          requestId: ctx.requestId,
        },
        createRunBudget({}),
      );
      const tool = createMaintenanceTicketTool({ db, outboundSync });
      const input: CreateMaintenanceTicketInput = {
        title: accion.titulo,
        description: accion.descripcion,
        origin: "huesped",
        severity: accion.severidad,
        estimatedCost: 0,
      };
      const result = await tool.run(toolCtx, input);
      const ticketId = result.ok ? ((result.data as { ticketId?: string } | undefined)?.ticketId ?? null) : null;

      const { rows } = await db.query<{ id: string }>(
        `insert into public.guest_review_action
           (tenant_id, hotel_id, review_id, action_type, status, ticket_id, detail, reason, resolved_at)
         values ($1, $2, $3, 'ticket_mantenimiento', 'ejecutada', $4, $5::jsonb, $6, now())
         returning id;`,
        [ctx.orgId, ctx.hotelId, reviewId, ticketId, JSON.stringify({ tema: accion.tema, severidad: accion.severidad }), accion.razon],
      );
      persistidas.push({
        id: rows[0]!.id,
        tipo: "ticket_mantenimiento",
        estado: "ejecutada",
        ticketId,
        detalle: { tema: accion.tema, severidad: accion.severidad },
        razon: accion.razon,
      });
      continue;
    }

    if (accion.tipo === "mensaje_proactivo") {
      const detalle = { mensajeSugerido: accion.mensajeSugerido };
      const { rows } = await db.query<{ id: string }>(
        `insert into public.guest_review_action
           (tenant_id, hotel_id, review_id, action_type, status, detail, reason)
         values ($1, $2, $3, 'mensaje_proactivo', 'pendiente', $4::jsonb, $5)
         returning id;`,
        [ctx.orgId, ctx.hotelId, reviewId, JSON.stringify(detalle), accion.razon],
      );
      persistidas.push({ id: rows[0]!.id, tipo: "mensaje_proactivo", estado: "pendiente", ticketId: null, detalle, razon: accion.razon });
      continue;
    }

    // compensacion_reglada
    const detalle = { tema: accion.tema, compensacion: accion.compensacion };
    const { rows } = await db.query<{ id: string }>(
      `insert into public.guest_review_action
         (tenant_id, hotel_id, review_id, action_type, status, detail, reason)
       values ($1, $2, $3, 'compensacion_reglada', 'pendiente', $4::jsonb, $5)
       returning id;`,
      [ctx.orgId, ctx.hotelId, reviewId, JSON.stringify(detalle), accion.razon],
    );
    persistidas.push({ id: rows[0]!.id, tipo: "compensacion_reglada", estado: "pendiente", ticketId: null, detalle, razon: accion.razon });
  }

  return persistidas;
}

/**
 * REQ-CRM-003: para cada tema mencionado negativamente en la reseña recién
 * clasificada, calcula cuántas reseñas ANTERIORES del mismo hotel (dentro de la
 * ventana configurada) mencionaron ese mismo tema con sentimiento negativo, y llama a
 * la política pura `evaluarAcumulacionTicket` para decidir si corresponde un ticket
 * automático adicional. Se salta cualquier tema que YA recibió un ticket en ESTA
 * misma reseña (`accionesYaPersistidas`, típicamente un tema de `TICKET_TOPICS` vía
 * REQ-CRM-002) para no evaluarlo dos veces en la misma petición.
 */
async function evaluarAcumulacionPorTemas(
  db: DbClient,
  ctx: { hotelId: string },
  reviewId: string,
  fechaActual: Date,
  temasNegativosActuales: ReviewTopicId[],
  accionesYaPersistidas: AccionPersistida[],
): Promise<AccionReputacion[]> {
  const config = ACUMULACION_TICKET_DEFAULT;
  const ventanaInicioIso = new Date(fechaActual.getTime() - config.ventanaDias * 24 * 60 * 60 * 1000).toISOString();

  const temasYaTicketeadosEnEstaResena = new Set(
    accionesYaPersistidas.filter((a) => a.tipo === "ticket_mantenimiento").map((a) => (a.detalle as { tema?: string }).tema),
  );
  const temasACheck = temasNegativosActuales.filter((t) => !temasYaTicketeadosEnEstaResena.has(t));
  if (temasACheck.length === 0) return [];

  // Una sola consulta trae todas las reseñas negativas previas del hotel dentro de la
  // ventana (excluyendo la reseña actual) -- el filtro por tema exacto se hace en
  // memoria porque `topics` es un arreglo jsonb de objetos {topic,...}, no una columna
  // indexable por tema individual (volumen esperado por hotel/ventana de 14 días es
  // bajo, no amerita una tabla de agregación separada todavía).
  const { rows: historicoRows } = await db.query<{ created_at: string; topics: { topic: string }[] }>(
    `select created_at::text as created_at, topics
     from public.guest_review
     where hotel_id = $1 and id <> $2 and sentiment in ('negativo', 'muy_negativo')
       and created_at >= $3 and created_at <= $4;`,
    [ctx.hotelId, reviewId, ventanaInicioIso, fechaActual.toISOString()],
  );

  const acciones: AccionReputacion[] = [];
  for (const tema of temasACheck) {
    const fechasMencionesPrevias = historicoRows
      .filter((r) => r.topics.some((t) => t.topic === tema))
      .map((r) => new Date(r.created_at));

    // ¿Ya existe un ticket de mantenimiento (de esta regla o de REQ-CRM-002) para este
    // mismo tema dentro de la ventana? Si sí, la acumulación actual ya está cubierta --
    // nunca se abre un segundo ticket para el mismo patrón todavía sin resolver.
    const { rows: ticketRecienteRows } = await db.query<{ id: string }>(
      `select gra.id
       from public.guest_review_action gra
       where gra.hotel_id = $1 and gra.action_type = 'ticket_mantenimiento'
         and gra.detail->>'tema' = $2 and gra.created_at >= $3
       limit 1;`,
      [ctx.hotelId, tema, ventanaInicioIso],
    );

    const evaluacion = evaluarAcumulacionTicket({
      fechaActual,
      fechasMencionesPrevias,
      yaExisteTicketReciente: ticketRecienteRows.length > 0,
      config,
    });

    if (!evaluacion.disparaTicket) continue;

    acciones.push({
      tipo: "ticket_mantenimiento",
      tema,
      severidad: "alta",
      titulo: `Ticket automático por acumulación de reseñas negativas: ${tema}`,
      descripcion:
        `${evaluacion.totalMenciones} menciones negativas del tema "${tema}" en los últimos ${evaluacion.ventanaDias} días ` +
        `(umbral configurado: ${evaluacion.umbralMenciones}).`,
      razon:
        `REQ-CRM-003: se acumularon ${evaluacion.totalMenciones} menciones negativas del tema "${tema}" dentro de una ` +
        `ventana de ${evaluacion.ventanaDias} días (umbral: ${evaluacion.umbralMenciones}) -- ningún ticket previo cubre ` +
        "esta acumulación todavía.",
    });
  }

  return acciones;
}

interface AccionRow {
  id: string;
  action_type: string;
  status: string;
  ticket_id: string | null;
  detail: Record<string, unknown>;
  reason: string;
  created_at: string;
}

function mapAccionRow(a: AccionRow) {
  return {
    id: a.id,
    tipo: a.action_type,
    estado: a.status,
    ticketId: a.ticket_id,
    detalle: a.detail,
    razon: a.reason,
    creadoEn: a.created_at,
  };
}

export function reputacionRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reputacion/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/reputacion/resenas", async (c) => {
    assertRole(c, REVIEW_SUBMIT_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(clasificarResenaSchema, await c.req.json().catch(() => ({})));

    // La reservación (si se da) es la ÚNICA fuente de verdad del estado de estancia y
    // del huésped -- nunca se confía en un `estanciaEstado` que mandara el cliente,
    // exactamente el mismo criterio de "la RLS/la fila real es la autoridad" que usa
    // el resto de este backend.
    let stayState: StayState = "desconocido";
    let guestId: string | null = body.huespedId ?? null;
    let folioId: string | null = null;

    if (body.reservaId) {
      const { rows } = await db.query<{ id: string; status: string; guest_id: string | null }>(
        "select id, status::text as status, guest_id from public.reservation where id = $1 and hotel_id = $2;",
        [body.reservaId, hotelId],
      );
      if (rows.length === 0) throw Errors.notFound("La reservación indicada no existe en este hotel.");
      stayState = stayStateFromReservationStatus(rows[0]!.status);
      guestId = guestId ?? rows[0]!.guest_id;

      const { rows: folioRows } = await db.query<{ id: string }>(
        "select id from public.folio where reservation_id = $1;",
        [body.reservaId],
      );
      folioId = folioRows[0]?.id ?? null;
    }

    if (guestId) {
      const { rows: guestRows } = await db.query<{ id: string }>(
        "select id from public.guest where id = $1 and hotel_id = $2;",
        [guestId, hotelId],
      );
      if (guestRows.length === 0) throw Errors.validation("El huésped indicado no pertenece a este hotel.");
    }

    const resultado = clasificarResena({
      texto: body.texto,
      calificacion: body.calificacion,
      estanciaEstado: stayState,
      huespedId: guestId,
    });

    const { rows: insertRows } = await db.query<{ id: string; created_at: string }>(
      `insert into public.guest_review
         (tenant_id, hotel_id, guest_id, folio_id, source, external_id, texto, idioma, calificacion,
          stay_state, is_public, topics, sentiment, sentiment_score, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
       on conflict (hotel_id, source, external_id) where external_id is not null do nothing
       returning id, created_at::text as created_at;`,
      [
        orgId,
        hotelId,
        guestId,
        folioId,
        body.fuente,
        body.externalId ?? null,
        body.texto,
        body.idioma,
        body.calificacion ?? null,
        stayState,
        body.esPublica,
        JSON.stringify(resultado.temas),
        resultado.sentimiento.etiqueta,
        resultado.sentimiento.puntaje,
        c.get("userId"),
      ],
    );

    if (insertRows.length === 0) {
      // Idempotencia de ingesta (mismo `external_id` de la misma plataforma, mismo
      // hotel): ya se clasificó y ya se dispararon sus acciones antes -- nunca se
      // reclasifica ni se vuelve a disparar un ticket/mensaje/compensación duplicado.
      const { rows: existentes } = await db.query<{ id: string; topics: unknown; sentiment: string; sentiment_score: string; created_at: string }>(
        `select id, topics, sentiment::text as sentiment, sentiment_score::text as sentiment_score, created_at::text as created_at
         from public.guest_review where hotel_id = $1 and source = $2 and external_id = $3;`,
        [hotelId, body.fuente, body.externalId],
      );
      const existente = existentes[0]!;
      const { rows: accionRows } = await db.query<AccionRow>(
        `select id, action_type, status::text as status, ticket_id, detail, reason, created_at::text as created_at
         from public.guest_review_action where review_id = $1 order by created_at;`,
        [existente.id],
      );
      return c.json(
        {
          id: existente.id,
          yaExistente: true,
          temas: existente.topics,
          sentimiento: existente.sentiment,
          puntajeSentimiento: Number(existente.sentiment_score),
          acciones: accionRows.map(mapAccionRow),
        },
        200,
      );
    }

    const reviewId = insertRows[0]!.id;
    let acciones = await persistirAcciones(
      db,
      { orgId, hotelId, userId: c.get("userId"), requestId: c.get("requestId") },
      reviewId,
      resultado.acciones,
      deps.outboundTaskSyncGateway,
    );

    // REQ-CRM-003: evalúa acumulación de menciones negativas del mismo tema entre
    // reseñas (ver comentario de archivo) -- solo tiene sentido cuando esta reseña en
    // sí es negativa (una reseña positiva nunca aporta una "mención negativa" al
    // conteo, mismo criterio que REQ-CRM-002).
    if (esSentimientoNegativo(resultado.sentimiento.etiqueta) && resultado.temas.length > 0) {
      const accionesAcumulacion = await evaluarAcumulacionPorTemas(
        db,
        { hotelId },
        reviewId,
        new Date(insertRows[0]!.created_at),
        resultado.temas.map((t) => t.topic),
        acciones,
      );
      if (accionesAcumulacion.length > 0) {
        const persistidasAcumulacion = await persistirAcciones(
          db,
          { orgId, hotelId, userId: c.get("userId"), requestId: c.get("requestId") },
          reviewId,
          accionesAcumulacion,
          deps.outboundTaskSyncGateway,
        );
        acciones = acciones.concat(persistidasAcumulacion);
      }
    }

    return c.json(
      {
        id: reviewId,
        yaExistente: false,
        temas: resultado.temas,
        sentimiento: resultado.sentimiento.etiqueta,
        puntajeSentimiento: resultado.sentimiento.puntaje,
        acciones: acciones.map((a) => ({ id: a.id, tipo: a.tipo, estado: a.estado, ticketId: a.ticketId, detalle: a.detalle, razon: a.razon })),
      },
      201,
    );
  });

  app.get("/hoteles/:hotelId/reputacion/resenas", async (c) => {
    assertRole(c, REVIEW_VIEW_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows } = await db.query<{
      id: string;
      source: string;
      external_id: string | null;
      texto: string;
      calificacion: number | null;
      stay_state: string;
      is_public: boolean;
      topics: unknown;
      sentiment: string;
      sentiment_score: string;
      created_at: string;
      acciones: AccionRow[];
    }>(
      `select gr.id, gr.source::text as source, gr.external_id, gr.texto, gr.calificacion,
              gr.stay_state::text as stay_state, gr.is_public, gr.topics,
              gr.sentiment::text as sentiment, gr.sentiment_score::text as sentiment_score,
              gr.created_at::text as created_at,
              coalesce(
                (select jsonb_agg(jsonb_build_object(
                    'id', a.id, 'action_type', a.action_type, 'status', a.status,
                    'ticket_id', a.ticket_id, 'detail', a.detail, 'reason', a.reason,
                    'created_at', a.created_at::text
                  ) order by a.created_at)
                 from public.guest_review_action a where a.review_id = gr.id),
                '[]'::jsonb
              ) as acciones
       from public.guest_review gr
       where gr.hotel_id = $1
       order by gr.created_at desc
       limit 200;`,
      [hotelId],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        fuente: r.source,
        externalId: r.external_id,
        texto: r.texto,
        calificacion: r.calificacion,
        estanciaEstado: r.stay_state,
        esPublica: r.is_public,
        temas: r.topics,
        sentimiento: r.sentiment,
        puntajeSentimiento: Number(r.sentiment_score),
        creadoEn: r.created_at,
        acciones: r.acciones.map(mapAccionRow),
      })),
    );
  });

  // Marca una acción pendiente (mensaje proactivo enviado, compensación aplicada) como
  // ejecutada o descartada -- solo owner/gm/accountant (compensación es dinero, mismo
  // criterio de rol que fraude/night-audit).
  app.patch("/hoteles/:hotelId/reputacion/acciones/:accionId", async (c) => {
    assertRole(c, REVIEW_ACTION_RESOLVE_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const accionId = c.req.param("accionId");
    const body = parseBody(resolverAccionSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string; status: string }>(
      `update public.guest_review_action
       set status = $1, resolved_by = $2, resolved_at = now()
       where id = $3 and hotel_id = $4 and status = 'pendiente'
       returning id, status::text as status;`,
      [body.estado, c.get("userId"), accionId, hotelId],
    );
    if (rows.length === 0) {
      throw Errors.notFound("La acción no existe, no pertenece a este hotel, o ya fue resuelta antes.");
    }
    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  return app;
}
