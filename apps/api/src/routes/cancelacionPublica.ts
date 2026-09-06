// H4 · POST /reservas/cancelacion-publica — REQ-RES-005/H03-025: "el sistema debe exigir
// verificación de identidad (código de reserva + apellido) antes de procesar cualquier
// cancelación solicitada por chat/voz". Sin sesión de staff (el huésped no tiene una
// cuenta de `hotel_staff`): usa el cliente ADMIN de `packages/db` para poder llamar a
// `cancel_reservation_public()` (SECURITY DEFINER, migración 0013), mismo criterio que
// `routes/auth.ts` usa para el lookup de login antes de que exista `auth.uid()` — la
// autorización real la hace la propia función SQL comparando código+apellido, nunca la
// pertenencia a un hotel (el huésped no la tiene).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const cancelacionPublicaSchema = z.object({
  codigoReserva: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
});

interface ReservationRow {
  id: string;
  status: string;
  confirmation_code: string;
  cancellation_penalty_amount: string | null;
}

export function cancelacionPublicaRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.post("/reservas/cancelacion-publica", async (c) => {
    const body = parseBody(cancelacionPublicaSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await deps.engine.admin.query<ReservationRow>(
        "select * from public.cancel_reservation_public($1, $2);",
        [body.codigoReserva, body.apellido],
      );
      const reservation = rows[0]!;
      return c.json({
        id: reservation.id,
        estado: reservation.status,
        codigoConfirmacion: reservation.confirmation_code,
        montoPenalizacion: reservation.cancellation_penalty_amount != null ? Number(reservation.cancellation_penalty_amount) : 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mensaje genérico (mismo criterio que /auth/login): nunca revela si el código o
      // el apellido fue la parte incorrecta — 0 cancelaciones ejecutadas ante un dato
      // erróneo (REQ-RES-005).
      if (/cancelacion_no_verificada/.test(message)) {
        throw Errors.unauthorized("El código de reserva y el apellido no coinciden con ninguna reserva cancelable.");
      }
      if (/transicion_invalida/.test(message)) {
        throw Errors.conflict("Esta reserva ya no admite cancelación (estado actual no cancelable).");
      }
      throw err;
    }
  });

  return app;
}
