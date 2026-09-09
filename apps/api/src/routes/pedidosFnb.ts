// REQ-AB-004 (P0/GOB) · /hoteles/:hotelId/pedidos-fnb — superficie MÍNIMA de pedidos de
// F&B necesaria para aplicar la regla de dominio: cuando el huésped declara una
// alergia/restricción alimentaria (campo estructurado O detectada defensivamente en
// texto libre, ver `resolveAllergyDeclared`), el pedido queda marcado y NINGÚN
// endpoint puede "asegurar" al huésped que el platillo es seguro hasta que un cocinero
// (rol `fnb`) lo confirme humanamente (`assertCanAssureDishIsSafe`).
//
// Esto NO implementa el enrutamiento a KDS/cocina, SLA de entrega ni cargo a folio de
// REQ-AB-002 (pendiente-credenciales de PMS/POS, ver docs/TRAZABILIDAD.md) -- esa es
// una pieza deliberadamente distinta y más grande; construirla aquí duplicaría trabajo
// fuera del alcance de este requisito.
import { Hono } from "hono";
import { z } from "zod";
import {
  AllergySafetyAssuranceBlockedError,
  assertCanAssureDishIsSafe,
  canAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  resolveAllergyDeclared,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Quién puede TOMAR un pedido de F&B (recepción suele tomarlo por teléfono/WhatsApp
// hasta que exista el canal real de REQ-AB-002; F&B y dirección también pueden).
const TOMAR_PEDIDO_ROLES = ["owner", "gm", "frontdesk", "fnb"] as const;
// Quién puede confirmar que la cocina revisó el platillo, o afirmar seguridad al
// huésped en su nombre -- deliberadamente MÁS estricto que tomar el pedido (ver
// comentario en la migración 0082_fnb_order.sql: nunca frontdesk).
const CONFIRMAR_COCINA_ROLES = ["owner", "gm", "fnb"] as const;

const itemSchema = z.object({
  nombre: z.string().trim().min(1).max(150),
  notas: z.string().trim().max(500).optional(),
});

const crearPedidoSchema = z.object({
  roomId: z.string().uuid().optional(),
  items: z.array(itemSchema).min(1).max(50),
  notas: z.string().trim().max(1000).optional(),
  alergiaDeclarada: z.boolean().default(false),
});

const confirmarCocinaSchema = z.object({
  nota: z.string().trim().max(1000).optional(),
});

interface PedidoRow {
  id: string;
  room_id: string | null;
  items: unknown;
  notes: string | null;
  allergy_declared: boolean;
  allergy_declared_via: string | null;
  kitchen_confirmed_by: string | null;
  kitchen_confirmed_at: string | null;
  kitchen_confirmation_note: string | null;
  safety_assurance_sent_by: string | null;
  safety_assurance_sent_at: string | null;
  created_at: string;
}

function serializePedido(p: PedidoRow) {
  const safetyState = { allergyDeclared: p.allergy_declared, kitchenConfirmedBy: p.kitchen_confirmed_by };
  return {
    id: p.id,
    roomId: p.room_id,
    items: p.items,
    notas: p.notes,
    alergiaDeclarada: p.allergy_declared,
    alergiaDetectadaVia: p.allergy_declared_via,
    cocineroConfirmoEn: p.kitchen_confirmed_at,
    cocineroConfirmoPor: p.kitchen_confirmed_by,
    // Ambos campos SIEMPRE se calculan en vivo desde la guarda de dominio -- nunca se
    // persisten como texto libre editable, para que no puedan quedar desincronizados
    // del estado real de confirmación (REQ-AB-004: "sin confirmación, el sistema no
    // debe afirmarlo").
    puedeAsegurarSeguridad: canAssureDishIsSafe(safetyState),
    mensajeSeguridad: describeSafetyAssuranceMessage(safetyState),
    seguridadAseguradaEn: p.safety_assurance_sent_at,
    creadoEn: p.created_at,
  };
}

export function pedidosFnbRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/pedidos-fnb/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/pedidos-fnb",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/pedidos-fnb", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<PedidoRow>(
      `select id, room_id, items, notes, allergy_declared, allergy_declared_via,
              kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
              kitchen_confirmation_note, safety_assurance_sent_by,
              safety_assurance_sent_at::text as safety_assurance_sent_at, created_at::text as created_at
       from public.fnb_order
       where hotel_id = $1
       order by created_at desc;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map(serializePedido));
  });

  app.post("/hoteles/:hotelId/pedidos-fnb", async (c) => {
    assertRole(c, [...TOMAR_PEDIDO_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(crearPedidoSchema, await c.req.json().catch(() => ({})));

    // Red de seguridad fail-closed: si el huésped no marcó el campo estructurado pero
    // SÍ escribió su alergia en una nota libre (notas generales o de algún platillo),
    // el pedido se trata igual que si lo hubiera declarado explícitamente.
    const { allergyDeclared, declaredVia } = resolveAllergyDeclared({
      structuredFlag: body.alergiaDeclarada,
      freeTextFields: [body.notas, ...body.items.map((it) => it.notas)],
    });

    const { rows } = await db.query<PedidoRow>(
      `insert into public.fnb_order (tenant_id, hotel_id, room_id, items, notes, allergy_declared, allergy_declared_via, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       returning id, room_id, items, notes, allergy_declared, allergy_declared_via,
                 kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
                 kitchen_confirmation_note, safety_assurance_sent_by,
                 safety_assurance_sent_at::text as safety_assurance_sent_at, created_at::text as created_at;`,
      [
        orgId,
        hotelId,
        body.roomId ?? null,
        JSON.stringify(body.items),
        body.notas ?? null,
        allergyDeclared,
        declaredVia,
        c.get("userId"),
      ],
    );

    return c.json(serializePedido(rows[0]!), 201);
  });

  app.get("/hoteles/:hotelId/pedidos-fnb/:orderId", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<PedidoRow>(
      `select id, room_id, items, notes, allergy_declared, allergy_declared_via,
              kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
              kitchen_confirmation_note, safety_assurance_sent_by,
              safety_assurance_sent_at::text as safety_assurance_sent_at, created_at::text as created_at
       from public.fnb_order
       where id = $1 and hotel_id = $2;`,
      [c.req.param("orderId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Pedido de F&B no encontrado.");
    return c.json(serializePedido(rows[0]!));
  });

  // Confirmación humana del cocinero (REQ-AB-004): la ÚNICA forma de que
  // `kitchen_confirmed_*` deje de ser null. Rechaza confirmar un pedido que no
  // declaró alergia -- no hay nada que un cocinero deba confirmar en ese caso.
  app.post("/hoteles/:hotelId/pedidos-fnb/:orderId/confirmar-cocina", async (c) => {
    assertRole(c, [...CONFIRMAR_COCINA_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orderId = c.req.param("orderId");
    const body = parseBody(confirmarCocinaSchema, await c.req.json().catch(() => ({})));

    const { rows: existing } = await db.query<{ id: string; allergy_declared: boolean }>(
      "select id, allergy_declared from public.fnb_order where id = $1 and hotel_id = $2;",
      [orderId, hotelId],
    );
    if (existing.length === 0) throw Errors.notFound("Pedido de F&B no encontrado.");
    if (!existing[0]!.allergy_declared) {
      throw Errors.conflict("Este pedido no declara alergia/restricción alimentaria; no requiere confirmación de cocina.");
    }

    const { rows } = await db.query<PedidoRow>(
      `update public.fnb_order
       set kitchen_confirmed_by = $1, kitchen_confirmed_at = now(), kitchen_confirmation_note = $2, updated_at = now()
       where id = $3 and hotel_id = $4
       returning id, room_id, items, notes, allergy_declared, allergy_declared_via,
                 kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
                 kitchen_confirmation_note, safety_assurance_sent_by,
                 safety_assurance_sent_at::text as safety_assurance_sent_at, created_at::text as created_at;`,
      [c.get("userId"), body.nota ?? null, orderId, hotelId],
    );

    return c.json(serializePedido(rows[0]!));
  });

  // Único endpoint que "asegura" al huésped que el platillo es seguro. Llama la
  // guarda de dominio ANTES de persistir nada: si el pedido tiene alergia declarada
  // sin confirmación, lanza 409 y la fila NUNCA se actualiza -- `safety_assurance_sent_at`
  // se queda en null, evidencia auditable de que el sistema no afirmó seguridad.
  app.post("/hoteles/:hotelId/pedidos-fnb/:orderId/asegurar-seguridad", async (c) => {
    assertRole(c, [...CONFIRMAR_COCINA_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orderId = c.req.param("orderId");

    const { rows: existing } = await db.query<{ id: string; allergy_declared: boolean; kitchen_confirmed_by: string | null }>(
      "select id, allergy_declared, kitchen_confirmed_by from public.fnb_order where id = $1 and hotel_id = $2;",
      [orderId, hotelId],
    );
    if (existing.length === 0) throw Errors.notFound("Pedido de F&B no encontrado.");

    try {
      assertCanAssureDishIsSafe({
        allergyDeclared: existing[0]!.allergy_declared,
        kitchenConfirmedBy: existing[0]!.kitchen_confirmed_by,
      });
    } catch (err) {
      if (err instanceof AllergySafetyAssuranceBlockedError) throw Errors.conflict(err.message);
      throw err;
    }

    const { rows } = await db.query<PedidoRow>(
      `update public.fnb_order
       set safety_assurance_sent_by = $1, safety_assurance_sent_at = now(), updated_at = now()
       where id = $2 and hotel_id = $3
       returning id, room_id, items, notes, allergy_declared, allergy_declared_via,
                 kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
                 kitchen_confirmation_note, safety_assurance_sent_by,
                 safety_assurance_sent_at::text as safety_assurance_sent_at, created_at::text as created_at;`,
      [c.get("userId"), orderId, hotelId],
    );

    return c.json(serializePedido(rows[0]!));
  });

  return app;
}
