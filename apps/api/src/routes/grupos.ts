// REQ-RES-013 (P2/F, H02-014/H07-027): "El sistema debe dar seguimiento automático a
// solicitudes de grupo sin respuesta (48h y 7 días) y requerir validación humana
// obligatoria antes de enviar cualquier propuesta de RFP." Este archivo es la única
// superficie HTTP de `solicitud_grupo`/`seguimiento_solicitud_grupo`/
// `validacion_humana_rfp`/`propuesta_rfp` (packages/db/migrations/
// 0130_seguimiento_solicitud_grupo.sql) -- REQ-RES-012 (cotización/room-block completos
// de grupos) sigue `pendiente` y NO es responsabilidad de este archivo; esto es
// deliberadamente el mínimo real que hace posible el seguimiento y el gate de RFP sin
// inventar el resto de ese requisito hermano.
//
// `POST .../grupos` calcula los 2 seguimientos (48h/7d) UNA SOLA VEZ, con la MISMA
// marca de tiempo (`creadaEn`) que se persiste en `solicitud_grupo.creada_en`, usando
// `computeGroupFollowUpSchedule` (@atiende-hoteles/domain-hotel) -- nunca se recalculan
// después (mismo criterio documentado en la migración). La ejecución real de esos
// seguimientos vencidos vive en `apps/api/src/jobs/seguimientoSolicitudGrupo.ts`
// (planificador en proceso, `server.ts`).
//
// `POST .../propuestas` re-verifica en la aplicación (`assertHumanValidationBeforeProposal`)
// ANTES de intentar el INSERT -- solo para devolver un 400 legible; la autoridad real e
// inapelable sigue siendo el trigger `propuesta_rfp_guard` de Postgres (0130), que
// bloquea cualquier intento aunque se salte esta ruta.
import { Hono } from "hono";
import { z } from "zod";
import {
  computeGroupFollowUpSchedule,
  assertHumanValidationBeforeProposal,
  PropuestaRfpSinValidacionError,
  type GroupFollowUpType,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const crearSolicitudSchema = z.object({
  organizadorNombre: z.string().trim().min(1).max(200),
  // E.164 -- mismo criterio de longitud mínima que `guest.phone`/`SendTextMessageInput.to`.
  organizadorTelefono: z.string().trim().min(8).max(20),
  organizadorEmail: z.string().trim().email().max(200).optional(),
  descripcion: z.string().trim().min(1).max(2000),
});

const validacionSchema = z.object({ notas: z.string().trim().max(1000).optional() });

const propuestaSchema = z.object({
  validacionId: z.string().uuid(),
  contenido: z.string().trim().min(1).max(4000),
  montoTotal: z.number().min(0).optional(),
  moneda: z.string().trim().length(3).optional(),
});

interface SolicitudRow {
  id: string;
  estado: string;
  organizador_nombre: string;
  organizador_telefono: string;
  organizador_email: string | null;
  descripcion: string;
  creada_en: string;
  respondida_en: string | null;
}

function serializeSolicitud(r: SolicitudRow) {
  return {
    id: r.id,
    estado: r.estado,
    organizadorNombre: r.organizador_nombre,
    organizadorTelefono: r.organizador_telefono,
    organizadorEmail: r.organizador_email,
    descripcion: r.descripcion,
    creadaEn: r.creada_en,
    respondidaEn: r.respondida_en,
  };
}

interface SeguimientoRow {
  id: string;
  tipo: GroupFollowUpType;
  programado_para: string;
  ejecutado_en: string | null;
}

function serializeSeguimiento(r: SeguimientoRow) {
  return { id: r.id, tipo: r.tipo, programadoPara: r.programado_para, ejecutadoEn: r.ejecutado_en };
}

interface ValidacionRow {
  id: string;
  solicitud_id: string;
  validado_por: string;
  validado_en: string;
  notas: string | null;
}

function serializeValidacion(r: ValidacionRow) {
  return { id: r.id, solicitudId: r.solicitud_id, validadoPor: r.validado_por, validadoEn: r.validado_en, notas: r.notas };
}

interface PropuestaRow {
  id: string;
  solicitud_id: string;
  validacion_humana_id: string;
  contenido: string;
  monto_total: string | null;
  moneda: string | null;
  enviado_por: string | null;
  enviado_en: string;
}

function serializePropuesta(r: PropuestaRow) {
  return {
    id: r.id,
    solicitudId: r.solicitud_id,
    validacionHumanaId: r.validacion_humana_id,
    contenido: r.contenido,
    montoTotal: r.monto_total === null ? null : Number(r.monto_total),
    moneda: r.moneda,
    enviadoPor: r.enviado_por,
    enviadoEn: r.enviado_en,
  };
}

export function gruposRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/grupos",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/grupos/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/grupos", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const estado = c.req.query("estado");
    const { rows } = await db.query<SolicitudRow>(
      `select id, estado::text as estado, organizador_nombre, organizador_telefono, organizador_email,
              descripcion, creada_en::text as creada_en, respondida_en::text as respondida_en
       from public.solicitud_grupo
       where hotel_id = $1 and ($2::text is null or estado = $2)
       order by creada_en desc;`,
      [hotelId, estado ?? null],
    );
    return c.json(rows.map(serializeSolicitud));
  });

  app.post("/hoteles/:hotelId/grupos", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const userId = c.get("userId");
    const body = parseBody(crearSolicitudSchema, await c.req.json().catch(() => ({})));

    // Un único reloj (`creadaEn`) para AMBOS lados: la fecha persistida en
    // `solicitud_grupo.creada_en` y el cálculo de `computeGroupFollowUpSchedule` -- así
    // el seguimiento de 48h/7d siempre cuenta desde el mismo instante real de creación,
    // sin depender de que `now()` de Postgres y el reloj de la aplicación coincidan al
    // milisegundo.
    const creadaEn = new Date();
    const { rows } = await db.query<SolicitudRow>(
      `insert into public.solicitud_grupo
         (org_id, hotel_id, organizador_nombre, organizador_telefono, organizador_email, descripcion, creada_en, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, estado::text as estado, organizador_nombre, organizador_telefono, organizador_email,
                 descripcion, creada_en::text as creada_en, respondida_en::text as respondida_en;`,
      [orgId, hotelId, body.organizadorNombre, body.organizadorTelefono, body.organizadorEmail ?? null, body.descripcion, creadaEn, userId],
    );
    const solicitud = rows[0]!;

    const schedule = computeGroupFollowUpSchedule(creadaEn);
    const seguimientos: ReturnType<typeof serializeSeguimiento>[] = [];
    for (const item of schedule) {
      const { rows: segRows } = await db.query<SeguimientoRow>(
        `insert into public.seguimiento_solicitud_grupo (solicitud_id, tipo, programado_para)
         values ($1, $2, $3)
         returning id, tipo::text as tipo, programado_para::text as programado_para, ejecutado_en::text as ejecutado_en;`,
        [solicitud.id, item.tipo, item.programadoPara],
      );
      seguimientos.push(serializeSeguimiento(segRows[0]!));
    }

    return c.json({ ...serializeSolicitud(solicitud), seguimientos }, 201);
  });

  app.get("/hoteles/:hotelId/grupos/:id", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const solicitudId = c.req.param("id");

    const { rows } = await db.query<SolicitudRow>(
      `select id, estado::text as estado, organizador_nombre, organizador_telefono, organizador_email,
              descripcion, creada_en::text as creada_en, respondida_en::text as respondida_en
       from public.solicitud_grupo where id = $1 and hotel_id = $2;`,
      [solicitudId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Solicitud de grupo no encontrada.");

    const { rows: seguimientoRows } = await db.query<SeguimientoRow>(
      `select id, tipo::text as tipo, programado_para::text as programado_para, ejecutado_en::text as ejecutado_en
       from public.seguimiento_solicitud_grupo where solicitud_id = $1 order by programado_para asc;`,
      [solicitudId],
    );
    const { rows: validacionRows } = await db.query<ValidacionRow>(
      `select id, solicitud_id, validado_por, validado_en::text as validado_en, notas
       from public.validacion_humana_rfp where solicitud_id = $1 order by validado_en asc;`,
      [solicitudId],
    );
    const { rows: propuestaRows } = await db.query<PropuestaRow>(
      `select id, solicitud_id, validacion_humana_id, contenido, monto_total::text as monto_total, moneda,
              enviado_por, enviado_en::text as enviado_en
       from public.propuesta_rfp where solicitud_id = $1 order by enviado_en asc;`,
      [solicitudId],
    );

    return c.json({
      ...serializeSolicitud(rows[0]!),
      seguimientos: seguimientoRows.map(serializeSeguimiento),
      validaciones: validacionRows.map(serializeValidacion),
      propuestas: propuestaRows.map(serializePropuesta),
    });
  });

  // El organizador respondió por fuera del sistema (llamada, correo directo, etc.) --
  // marcar la solicitud como 'respondida' es lo único que DETIENE el seguimiento
  // automático (jobs/seguimientoSolicitudGrupo.ts filtra `estado = 'pendiente'`), sin
  // borrar ni tocar las filas de `seguimiento_solicitud_grupo` ya programadas.
  app.patch("/hoteles/:hotelId/grupos/:id/responder", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const solicitudId = c.req.param("id");
    const userId = c.get("userId");

    const { rows } = await db.query<{ id: string; estado: string }>(
      `update public.solicitud_grupo
       set estado = 'respondida', respondida_en = now(), respondida_por = $1, updated_at = now()
       where id = $2 and hotel_id = $3 and estado = 'pendiente'
       returning id, estado::text as estado;`,
      [userId, solicitudId, hotelId],
    );
    if (rows.length === 0) {
      throw Errors.notFound("Solicitud de grupo no encontrada, o ya no está pendiente de respuesta.");
    }
    return c.json({ id: rows[0]!.id, estado: rows[0]!.estado });
  });

  // Registro append-only de que UN humano (nunca el agente/LLM) revisó la solicitud --
  // requisito previo obligatorio para poder enviar cualquier propuesta de RFP (ver
  // POST .../propuestas más abajo y el trigger `propuesta_rfp_guard`, 0130).
  app.post("/hoteles/:hotelId/grupos/:id/validaciones", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const solicitudId = c.req.param("id");
    const userId = c.get("userId");
    const body = parseBody(validacionSchema, await c.req.json().catch(() => ({})));

    const { rows: solicitudRows } = await db.query<{ id: string }>(
      "select id from public.solicitud_grupo where id = $1 and hotel_id = $2;",
      [solicitudId, hotelId],
    );
    if (solicitudRows.length === 0) throw Errors.notFound("Solicitud de grupo no encontrada.");

    const { rows } = await db.query<ValidacionRow>(
      `insert into public.validacion_humana_rfp (solicitud_id, validado_por, notas)
       values ($1, $2, $3)
       returning id, solicitud_id, validado_por, validado_en::text as validado_en, notas;`,
      [solicitudId, userId, body.notas ?? null],
    );
    return c.json(serializeValidacion(rows[0]!), 201);
  });

  // "0 propuestas sin ese registro" (REQ-RES-013/docs/ACEPTACION.md): verificación de
  // aplicación (400 legible) ANTES de intentar el INSERT, seguida del trigger de
  // Postgres como autoridad real e inapelable (ver encabezado del archivo).
  app.post("/hoteles/:hotelId/grupos/:id/propuestas", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const solicitudId = c.req.param("id");
    const userId = c.get("userId");
    const body = parseBody(propuestaSchema, await c.req.json().catch(() => ({})));

    const { rows: solicitudRows } = await db.query<{ id: string }>(
      "select id from public.solicitud_grupo where id = $1 and hotel_id = $2;",
      [solicitudId, hotelId],
    );
    if (solicitudRows.length === 0) throw Errors.notFound("Solicitud de grupo no encontrada.");

    const { rows: validacionRows } = await db.query<{ id: string; solicitud_id: string; validado_en: string }>(
      "select id, solicitud_id, validado_en::text as validado_en from public.validacion_humana_rfp where id = $1;",
      [body.validacionId],
    );
    const validacionRow = validacionRows[0];
    const enviadoEn = new Date();

    try {
      assertHumanValidationBeforeProposal(
        solicitudId,
        validacionRow
          ? { id: validacionRow.id, solicitudId: validacionRow.solicitud_id, validadoEn: new Date(validacionRow.validado_en) }
          : null,
        enviadoEn,
      );
    } catch (err) {
      if (err instanceof PropuestaRfpSinValidacionError) throw Errors.validation(err.message);
      throw err;
    }

    let row: PropuestaRow;
    try {
      const { rows } = await db.query<PropuestaRow>(
        `insert into public.propuesta_rfp
           (solicitud_id, validacion_humana_id, contenido, monto_total, moneda, enviado_por, enviado_en)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, solicitud_id, validacion_humana_id, contenido, monto_total::text as monto_total, moneda,
                   enviado_por, enviado_en::text as enviado_en;`,
        [solicitudId, body.validacionId, body.contenido, body.montoTotal ?? null, body.moneda ?? null, userId, enviadoEn],
      );
      row = rows[0]!;
    } catch (err) {
      // Defensa en profundidad: si por lo que sea la verificación de aplicación de
      // arriba se saltó (p. ej. una carrera con un DELETE que este esquema no permite,
      // o un error propio no contemplado), el trigger de Postgres sigue siendo la
      // autoridad real -- se traduce su mensaje a un 400 legible en vez de un 500 opaco.
      const message = err instanceof Error ? err.message : String(err);
      if (/validacion_humana_no_encontrada/.test(message)) {
        throw Errors.validation("No existe el registro de validación humana indicado.");
      }
      if (/validacion_no_corresponde_a_solicitud/.test(message)) {
        throw Errors.validation("El registro de validación humana indicado corresponde a otra solicitud de grupo.");
      }
      if (/validacion_posterior_al_envio/.test(message)) {
        throw Errors.validation("El registro de validación humana debe ser previo al envío de la propuesta.");
      }
      throw err;
    }

    return c.json(serializePropuesta(row), 201);
  });

  return app;
}
