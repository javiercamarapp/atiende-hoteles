// REQ-UX-005/REQ-HUE-026 · /hoteles/:hotelId/conocimiento-local — panel del gerente
// para editar el conocimiento local (sargazo, clima, playa, ferry, eventos) que el
// agente conversacional consulta en vivo por WhatsApp. Esta ruta es la fuente de datos
// REAL: lectura sin caché, reflejada de inmediato tras cada escritura (probado en
// tests/integration/conocimiento-local/latencia.spec.ts). La CONEXIÓN de esa fuente con
// las respuestas del agente (lo que este comentario admitía como pendiente) vive en
// `apps/api/src/routes/mensajeria.ts` -- el único punto real de este repo que procesa un
// mensaje entrante de huésped: detecta si el texto pregunta por una de estas categorías
// (`detectLocalKnowledgeCategory`, domain-hotel) y responde leyendo esta misma tabla
// (`buildLocalKnowledgeReply`), sin caché intermedio -- eso es lo que hace real el
// "<30 s" del criterio de aceptación, con el canal WhatsApp simulado hoy
// (`FakeWhatsappAdapter`, ADR-007, sin credenciales de Meta) igual que
// REQ-HUE-006/014/021/023/024.
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";
import type { HotelRole } from "../domain/roles.ts";

// "Panel del GERENTE" (REQ-UX-005) -- owner/gm/frontdesk, mismo criterio que la RLS de
// packages/db/migrations/0052_local_knowledge.sql.
const MANAGE_LOCAL_KNOWLEDGE_ROLES: HotelRole[] = ["owner", "gm", "frontdesk"];

const CATEGORIES = ["sargazo", "clima", "playa", "ferry", "eventos", "otro"] as const;

const crearSchema = z.object({
  categoria: z.enum(CATEGORIES),
  titulo: z.string().trim().min(1).max(200),
  contenido: z.string().trim().min(1).max(4000),
});
const actualizarSchema = z.object({
  categoria: z.enum(CATEGORIES).optional(),
  titulo: z.string().trim().min(1).max(200).optional(),
  contenido: z.string().trim().min(1).max(4000).optional(),
});

interface EntryRow {
  id: string;
  category: string;
  title: string;
  content: string;
  updated_at: string;
}

function toEntryBody(row: EntryRow) {
  return { id: row.id, categoria: row.category, titulo: row.title, contenido: row.content, actualizadoEn: row.updated_at };
}

export function conocimientoLocalRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/conocimiento-local*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/conocimiento-local", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<EntryRow>(
      `select id, category, title, content, updated_at::text as updated_at
       from public.local_knowledge_entry where hotel_id = $1
       order by category asc, updated_at desc;`,
      [hotelId],
    );
    return c.json(rows.map(toEntryBody));
  });

  app.post("/hoteles/:hotelId/conocimiento-local", async (c) => {
    assertRole(c, MANAGE_LOCAL_KNOWLEDGE_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<EntryRow>(
      `insert into public.local_knowledge_entry (tenant_id, hotel_id, category, title, content, updated_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id, category, title, content, updated_at::text as updated_at;`,
      [orgId, hotelId, body.categoria, body.titulo, body.contenido, userId ?? null],
    );

    return c.json(toEntryBody(rows[0]!), 201);
  });

  app.patch("/hoteles/:hotelId/conocimiento-local/:entryId", async (c) => {
    assertRole(c, MANAGE_LOCAL_KNOWLEDGE_ROLES);
    const db = c.get("db");
    const userId = c.get("userId");
    const hotelId = c.req.param("hotelId");
    const entryId = c.req.param("entryId");
    const body = parseBody(actualizarSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<EntryRow>(
      `update public.local_knowledge_entry
       set category = coalesce($1, category),
           title = coalesce($2, title),
           content = coalesce($3, content),
           updated_by = $4,
           updated_at = now()
       where id = $5 and hotel_id = $6
       returning id, category, title, content, updated_at::text as updated_at;`,
      [body.categoria ?? null, body.titulo ?? null, body.contenido ?? null, userId ?? null, entryId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Entrada de conocimiento local no encontrada.");

    return c.json(toEntryBody(rows[0]!));
  });

  app.delete("/hoteles/:hotelId/conocimiento-local/:entryId", async (c) => {
    assertRole(c, MANAGE_LOCAL_KNOWLEDGE_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const entryId = c.req.param("entryId");

    const { rows } = await db.query<{ id: string }>(
      "delete from public.local_knowledge_entry where id = $1 and hotel_id = $2 returning id;",
      [entryId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Entrada de conocimiento local no encontrada.");

    return c.json({ id: rows[0]!.id, eliminado: true });
  });

  return app;
}
