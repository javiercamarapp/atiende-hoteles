// REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura de cargos ≥99.5%" (H10-020):
// "El sistema debe lograr una captura de cargos posteados/cheques cerrados a
// habitación superior a un umbral objetivo (p.ej. ≥99.5%), minimizando fuga manual."
// La otra mitad del mismo REQ (doble verificación de identidad, H10-022) ya está
// cerrada en `./folios.ts` (`assertRoomChargeIdentityVerified`) -- esta ruta NO la
// toca ni la reimplementa.
//
// Tres operaciones, todas sobre `room_charge_capture_attempt` (migración 0131):
//   1) declarar un intento cuando el staff CIERRA un consumo a una habitación (antes
//      de saber si terminará posteado -- ver el "por qué" en la migración/domain).
//   2) vincularlo al `charge` real una vez posteado ("capturado").
//   3) darlo por perdido con motivo ("fuga") -- decisión administrativa, ADMIN_ROLES,
//      mismo criterio que `evaluateFolioClose`/cuenta_por_cobrar.
// Y el reporte periódico en sí (`GET .../reportes/captura-cargos`), que agrega los
// intentos del rango y aplica `buildChargeCaptureReport` (@atiende-hoteles/domain-hotel).
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  ROOM_CHARGE_CAPTURE_SOURCES,
  validateRoomChargeCaptureAttempt,
  type RoomChargeCaptureSource,
} from "@atiende-hoteles/domain-hotel";
import { buildChargeCaptureReportForHotel } from "../domain/capturaCargos.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MONEY_ROLES, type HotelRole } from "../domain/roles.ts";
import { loadFolio } from "./folios.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

// Mismo criterio que `PL_ROLES` (plUsali.ts): el reporte es información financiera de
// supervisión (expone fuga operativa por fuente/monto), no una acción de folio
// individual -- owner/gm/accountant, nunca frontdesk/fnb (que sí pueden DECLARAR un
// intento, pero no necesitan ver el agregado del hotel).
export const CAPTURE_REPORT_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];

const attemptSchema = z.object({
  fuente: z.enum(ROOM_CHARGE_CAPTURE_SOURCES),
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().positive(),
  // ISO 8601 -- cuándo el consumo se CERRÓ a la habitación (comanda de F&B cerrada al
  // 304, vale de spa firmado, etc.), no cuándo se declara el intento en el sistema.
  ocurrioEn: z.string().trim().min(1).max(60),
});

const capturarSchema = z.object({
  chargeId: z.string().uuid(),
});

const fugaSchema = z.object({
  motivo: z.string().trim().min(1).max(300),
});

/** Tolerancia de un centavo -- mismo criterio que packages/domain-hotel/src/money.ts,
 *  folioEngine.ts y fraude/deteccion.ts para no rechazar por un residuo de redondeo
 *  real, y mismo umbral que `Errors.impuestoNoCoincide`. */
const AMOUNT_TOLERANCE = 0.01;

interface AttemptRow {
  id: string;
  folio_id: string;
  source: RoomChargeCaptureSource;
  description: string;
  amount: string;
  occurred_at: string;
  captured_by: string;
  charge_id: string | null;
  reconciled_status: "pendiente" | "capturado" | "fuga";
  reconciled_by: string | null;
  reconciled_at: string | null;
  leak_reason: string | null;
}

function serializeAttempt(row: AttemptRow) {
  return {
    id: row.id,
    folioId: row.folio_id,
    fuente: row.source,
    descripcion: row.description,
    monto: Number(row.amount),
    ocurrioEn: row.occurred_at,
    capturadoPor: row.captured_by,
    chargeId: row.charge_id,
    estado: row.reconciled_status,
    reconciliadoPor: row.reconciled_by,
    reconciliadoEn: row.reconciled_at,
    motivoFuga: row.leak_reason,
  };
}

/** Verifica que `attemptId` exista, pertenezca a ESTE hotel+folio y siga 'pendiente'
 *  -- SIEMPRE antes de llamar `resolve_room_charge_capture_attempt` (SECURITY
 *  DEFINER, bypasa RLS), nunca después (ver comentario en los handlers de arriba).
 *  Dos causas de rechazo, dos códigos distintos: 404 si el intento no existe (o
 *  existe pero en OTRO folio -- nunca se revela que existe en otro lado), 409 si
 *  existe en este folio pero ya fue resuelto (capturado o fuga). */
async function loadPendingAttempt(
  db: DbClient,
  hotelId: string,
  folioId: string,
  attemptId: string,
): Promise<{ amount: number }> {
  const { rows } = await db.query<{ reconciled_status: "pendiente" | "capturado" | "fuga"; amount: string }>(
    "select reconciled_status, amount from public.room_charge_capture_attempt where id = $1 and hotel_id = $2 and folio_id = $3;",
    [attemptId, hotelId, folioId],
  );
  const row = rows[0];
  if (!row) throw Errors.notFound("El intento no existe en este folio.");
  if (row.reconciled_status !== "pendiente") {
    throw Errors.conflict("El intento ya fue resuelto anteriormente (capturado o marcado como fuga).");
  }
  return { amount: Number(row.amount) };
}

export function capturaCargosRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/folios/:folioId/cargos-habitacion/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/reportes/captura-cargos",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // 1) Declarar un intento: cualquier rol de dinero que atienda el punto de consumo
  // (mismo conjunto que puede postear un cargo real, `MONEY_ROLES`).
  app.post("/hoteles/:hotelId/folios/:folioId/cargos-habitacion/intentos", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const userId = c.get("userId");
    const body = parseBody(attemptSchema, await c.req.json().catch(() => ({})));

    const folio = await loadFolio(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos intentos de cargo a habitación.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "room_charge_capture_attempt.create", key: idempotencyKey, body },
      async () => {
        const validation = validateRoomChargeCaptureAttempt({
          folioId,
          source: body.fuente,
          description: body.descripcion,
          amount: body.monto,
          occurredAt: body.ocurrioEn,
          capturedBy: userId,
        });
        if (!validation.valid) throw Errors.validation(validation.reasons.join(" | "));

        const { rows } = await db.query<AttemptRow>(
          `insert into public.room_charge_capture_attempt
             (tenant_id, hotel_id, folio_id, source, description, amount, occurred_at, captured_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, folio_id, source, description, amount, occurred_at::text as occurred_at,
                     captured_by, charge_id, reconciled_status, reconciled_by,
                     reconciled_at::text as reconciled_at, leak_reason;`,
          [orgId, hotelId, folioId, body.fuente, body.descripcion, body.monto, body.ocurrioEn, userId],
        );
        const created = rows[0]!;
        await db.query(
          "select public.record_audit_log($1, $2, 'room_charge_capture_attempt.created', 'room_charge_capture_attempt', $3, $4);",
          [orgId, hotelId, created.id, JSON.stringify(body)],
        );
        return { status: 201, body: serializeAttempt(created) };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // 2) Vincular el intento a un `charge` real ya posteado en el MISMO folio --
  // "capturado". No requiere rol administrativo: es solo registrar una correspondencia
  // ya ocurrida, cualquier rol de dinero puede hacerlo (mismo criterio de acceso que
  // declarar el intento).
  app.post("/hoteles/:hotelId/folios/:folioId/cargos-habitacion/intentos/:intentoId/capturar", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const userId = c.get("userId");
    const body = parseBody(capturarSchema, await c.req.json().catch(() => ({})));

    await loadFolio(db, hotelId, folioId);
    const { rows: chargeRows } = await db.query<{ id: string; amount: string }>(
      "select id, amount from public.charge where id = $1 and folio_id = $2;",
      [body.chargeId, folioId],
    );
    const charge = chargeRows[0];
    if (!charge) throw Errors.notFound("El charge indicado no existe en este folio.");

    // Fraude REQ-AB-012/H10-020: sin este chequeo, cualquier rol de dinero
    // (frontdesk/fnb/reservations -- NO requiere rol administrativo) podía reutilizar
    // un único `charge` real ya vinculado a otro intento para marcar "capturado" un
    // número arbitrario de intentos de fuga real, inflando artificialmente la tasa de
    // captura ≥99.5% que este REQ existe para vigilar. Backstop de aplicación ANTES de
    // `resolve_room_charge_capture_attempt` (mismo criterio de "verificar antes de
    // mutar" del comentario de abajo); el backstop de base de datos es el UNIQUE INDEX
    // parcial `room_charge_capture_attempt_charge_id_unique_idx` (migración 0134).
    const { rows: reuseRows } = await db.query<{ id: string }>(
      "select id from public.room_charge_capture_attempt where charge_id = $1 and reconciled_status = 'capturado' limit 1;",
      [body.chargeId],
    );
    if (reuseRows.length > 0) throw Errors.chargeYaCapturadoPorOtroIntento();

    // `resolve_room_charge_capture_attempt` es SECURITY DEFINER (bypasa RLS, mismo
    // patrón que `mark_charge_reversed`) -- por eso el scoping a ESTE folio/hotel debe
    // verificarse ANTES de llamarla, nunca después: si se verificara después, un
    // intentoId de OTRO hotel ya habría sido mutado (resuelto con datos ajenos) para
    // cuando detectáramos el desajuste. `reverseCharge` (./folios.ts) sigue el mismo
    // principio con el `charge` original antes de `mark_charge_reversed`.
    const attempt = await loadPendingAttempt(db, hotelId, folioId, c.req.param("intentoId"));

    // Fraude REQ-AB-012/H10-020: sin validar el monto, un intento de fuga real grande
    // podía "capturarse" vinculándolo a un `charge` real minúsculo cualquiera del mismo
    // folio -- el reporte lo contaría como capturado por construcción aunque el monto
    // real fugado nunca se hubiera posteado.
    const chargeAmount = Number(charge.amount);
    if (Math.abs(chargeAmount - attempt.amount) > AMOUNT_TOLERANCE) {
      throw Errors.montoCapturaNoCoincide(attempt.amount, chargeAmount);
    }

    const { rows } = await db.query<AttemptRow>(
      `select id, folio_id, source, description, amount, occurred_at::text as occurred_at,
              captured_by, charge_id, reconciled_status, reconciled_by,
              reconciled_at::text as reconciled_at, leak_reason
       from public.resolve_room_charge_capture_attempt($1, $2, null, $3);`,
      [c.req.param("intentoId"), body.chargeId, userId],
    );
    const resolved = rows[0]!;
    await db.query(
      "select public.record_audit_log($1, $2, 'room_charge_capture_attempt.capturado', 'room_charge_capture_attempt', $3, $4);",
      [orgId, hotelId, resolved.id, JSON.stringify({ chargeId: body.chargeId })],
    );
    return c.json(serializeAttempt(resolved));
  });

  // 3) Dar por perdido un intento -- decisión administrativa (owner/gm), nunca de un
  // rol operativo por su cuenta: mismo criterio que `evaluateFolioClose`/cuenta_por_cobrar,
  // aceptar una fuga es una afirmación de que ese dinero YA NO se va a cobrar.
  app.post("/hoteles/:hotelId/folios/:folioId/cargos-habitacion/intentos/:intentoId/fuga", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const userId = c.get("userId");
    const body = parseBody(fugaSchema, await c.req.json().catch(() => ({})));

    await loadFolio(db, hotelId, folioId);
    // Ver comentario del endpoint "capturar": scoping ANTES de la función SECURITY
    // DEFINER, nunca después.
    await loadPendingAttempt(db, hotelId, folioId, c.req.param("intentoId"));

    const { rows } = await db.query<AttemptRow>(
      `select id, folio_id, source, description, amount, occurred_at::text as occurred_at,
              captured_by, charge_id, reconciled_status, reconciled_by,
              reconciled_at::text as reconciled_at, leak_reason
       from public.resolve_room_charge_capture_attempt($1, null, $2, $3);`,
      [c.req.param("intentoId"), body.motivo, userId],
    );
    const resolved = rows[0]!;
    await db.query(
      "select public.record_audit_log($1, $2, 'room_charge_capture_attempt.fuga', 'room_charge_capture_attempt', $3, $4);",
      [orgId, hotelId, resolved.id, JSON.stringify(body)],
    );
    return c.json(serializeAttempt(resolved));
  });

  // Reporte periódico REQ-AB-012/H10-020: tasa de captura real del hotel en [desde,
  // hasta] contra el umbral parametrizado del hotel (`hotel_tax_config.charge_capture_rate_target`).
  app.get("/hoteles/:hotelId/reportes/captura-cargos", async (c) => {
    assertRole(c, CAPTURE_REPORT_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const desde = parseIsoDate(c.req.query("desde"), "desde");
    const hasta = parseIsoDate(c.req.query("hasta"), "hasta");
    if (desde > hasta) throw Errors.validation('El parámetro "desde" no puede ser posterior a "hasta".');

    const report = await buildChargeCaptureReportForHotel(db, hotelId, desde, hasta);
    return c.json({
      hotelId: report.hotelId,
      desde: report.desde,
      hasta: report.hasta,
      totalIntentos: report.totalAttempts,
      capturados: report.captured,
      fuga: report.leaked,
      pendientes: report.pending,
      tasaCaptura: report.captureRate,
      umbralObjetivo: report.targetRate,
      cumpleUmbral: report.meetsTarget,
      intentosSinCapturar: report.uncapturedAttempts.map((a) => ({
        id: a.id,
        estado: a.status,
        monto: a.amount,
        descripcion: a.description,
        fuente: a.source,
        ocurrioEn: a.occurredAt,
      })),
    });
  });

  return app;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string | undefined, paramName: string): string {
  if (!value || !ISO_DATE_RE.test(value)) {
    throw Errors.validation(`El parámetro "${paramName}" es obligatorio y debe tener formato YYYY-MM-DD.`);
  }
  return value;
}
