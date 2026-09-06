// REQ-TEN-004 (GOB-039) · "pedido de huésped sin cuenta" pasando exclusivamente por
// una RPC SECURITY DEFINER que recalcula el precio en servidor -- ver migración 0050
// para el detalle completo. Igual que `cancelacionPublica.ts` (REQ-RES-005): sin
// sesión de staff, se usa el cliente ADMIN de `packages/db` para invocar la función,
// la autorización real la hace la propia función SQL comparando código+apellido. El
// rate limit por IP ya aplica globalmente (`ipRateLimit`, ver apps/api/src/app.ts).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Deliberadamente SIN `precio`/`total` en el esquema: Zod (modo por defecto "strip")
// descarta cualquier campo no declarado del body -- si un cliente envía
// `precio`/`total` (p. ej. intentando cobrar `0.01`), ese campo simplemente nunca
// llega a `body` ni a la RPC, que además no tiene ningún parámetro de precio (ver
// migración 0050). El monto que termina en el folio SIEMPRE es
// `experience_catalog.price × cantidad`, calculado en servidor (REQ-TEN-004,
// verificado en tests/adversarial/rpc-security-definer.spec.ts).
const pedidoPublicoSchema = z.object({
  codigoReserva: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
  experienciaId: z.string().uuid(),
  cantidad: z.number().int().min(1).max(20),
  clienteRequestId: z.string().trim().min(1).max(200).optional(),
});

interface OrderRow {
  order_id: string;
  unit_price: string;
  total_amount: string;
  ya_registrado: boolean;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  price: string;
}

export function experienciasPublicasRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // Catálogo público de un hotel (solo nombre/descripción/precio -- REQ-HUE-023: nunca
  // se expone información de otro huésped ni de otro hotel).
  app.get("/hoteles/:hotelId/experiencias-publicas", async (c) => {
    const hotelId = c.req.param("hotelId");
    const { rows } = await deps.engine.admin.query<CatalogRow>(
      "select id, name, description, price::text as price from public.list_experience_catalog_public($1);",
      [hotelId],
    );
    return c.json(
      rows.map((r) => ({ id: r.id, nombre: r.name, descripcion: r.description, precio: Number(r.price) })),
    );
  });

  app.post("/experiencias-publicas/pedido", async (c) => {
    const body = parseBody(pedidoPublicoSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await deps.engine.admin.query<OrderRow>(
        "select * from public.order_experience_public($1, $2, $3, $4, $5);",
        [body.codigoReserva, body.apellido, body.experienciaId, body.cantidad, body.clienteRequestId ?? null],
      );
      const order = rows[0]!;
      return c.json(
        {
          pedidoId: order.order_id,
          precioUnitario: Number(order.unit_price),
          total: Number(order.total_amount),
          yaRegistrado: order.ya_registrado,
        },
        order.ya_registrado ? 200 : 201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mismo criterio que /reservas/cancelacion-publica: nunca revela cuál de las dos
      // partes (código/apellido) fue la incorrecta.
      if (/pedido_no_verificado/.test(message)) {
        throw Errors.unauthorized("El código de reserva y el apellido no coinciden con ninguna reserva activa.");
      }
      if (/reserva_no_activa/.test(message)) {
        throw Errors.conflict("Esta reserva no admite pedidos en su estado actual.");
      }
      if (/experiencia_no_disponible/.test(message)) {
        throw Errors.notFound("La experiencia solicitada no existe o no está disponible.");
      }
      if (/cantidad_invalida/.test(message)) {
        throw Errors.validation("La cantidad debe ser entre 1 y 20.");
      }
      throw err;
    }
  });

  return app;
}
