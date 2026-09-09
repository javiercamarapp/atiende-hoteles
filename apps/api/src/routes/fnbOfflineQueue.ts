// REQ-AB-003 (P1/F) · /hoteles/:hotelId/fnb-offline-queue — reconciliación de un cargo
// o reverso de F&B capturado por un dispositivo SIN conectividad (playa/alberca) al
// recuperar señal. El reverso/anulación EN LÍNEA de cualquier concepto (incluido 'ab')
// ya existe genéricamente desde `packages/db/migrations/0030_folio_engine.sql`
// (`POST /hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso`,
// `reverseCharge()` en `routes/folios.ts`) -- esta ruta reutiliza EXACTAMENTE esa
// función para el caso 'reverso', nunca una segunda implementación que pudiera
// divergir.
//
// Diseño DELIBERADAMENTE de un ítem por solicitud (no un lote): el dispositivo, al
// recuperar señal, reenvía cada operación de su cola local como su PROPIA solicitud
// HTTP con su PROPIO `Idempotency-Key` -- exactamente el mismo contrato que cualquier
// otro POST mutador de esta API (ADR-004). Esto evita el problema de un lote
// heterogéneo dentro de una sola transacción de sesión (ADR-004 "una transacción por
// request"): si un ítem detona un CHECK de base de datos, Postgres aborta ESA
// transacción completa -- con un ítem por solicitud, esa transacción es exactamente la
// de esa operación, así que un rechazo nunca contamina ítems hermanos ni deja cargos
// "fantasma" a medio insertar (todo-o-nada por ítem, vía la transacción de la request).
//
// Cada llamada SIEMPRE produce un renglón en `fnb_offline_charge_queue`
// (`aplicado` o `rechazado`) -- nunca se descarta un ítem en silencio: si la operación
// de negocio se rechaza (folio cerrado, identidad no verificada, cargo ya reversado),
// esta ruta responde 201 igual (la RECONCILIACIÓN en sí fue exitosa: se registró qué
// pasó) con el resultado explícito en el cuerpo, para que el dispositivo pueda mostrarle
// al staff exactamente qué ítems necesitan corregirse y reintentarse con un nuevo
// Idempotency-Key -- nunca queda un ítem "perdido" sin razón visible.
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  computeChargeAmounts,
  validateFnbOfflineQueueItem,
  assertRoomChargeIdentityVerified,
  RoomChargeIdentityBlockedError,
  type FnbOfflineQueueItemInput,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { isAdminStaff } from "../lib/staffAuth.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { HotelRole } from "../domain/roles.ts";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";
import { loadFolio, loadGuestForFolio, reverseCharge, verificacionIdentidadSchema } from "./folios.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

// Mismo conjunto que puede TOMAR un pedido de F&B (`pedidosFnb.ts` TOMAR_PEDIDO_ROLES)
// -- quien captura el consumo en el punto de venta es quien sincroniza la cola offline.
const OFFLINE_QUEUE_ROLES: HotelRole[] = ["owner", "gm", "frontdesk", "fnb"];

const offlineQueueItemSchema = z.object({
  operationType: z.enum(["cargo", "reverso"]),
  folioId: z.string().uuid(),
  // Requerido solo para 'reverso' (el cargo original a anular).
  originalChargeId: z.string().uuid().optional().nullable(),
  descripcion: z.string().trim().min(1).max(300),
  monto: z.number().positive(),
  capturadoPor: z.string().uuid(),
  // ISO 8601 -- cuándo el DISPOSITIVO capturó la operación mientras estaba offline.
  capturadoOfflineEn: z.string().trim().min(1).max(60),
  deviceId: z.string().trim().min(1).max(200),
  motivoReverso: z.string().trim().min(1).max(300).optional(),
  verificacionIdentidad: verificacionIdentidadSchema.optional(),
});

interface QueueRow {
  id: string;
  operation_type: "cargo" | "reverso";
  reconciled_status: "aplicado" | "rechazado";
  result_charge_id: string | null;
  rejection_reason: string | null;
  captured_offline_at: string;
  reconciled_at: string;
}

async function insertQueueRow(
  db: DbClient,
  params: {
    orgId: string;
    hotelId: string;
    idempotencyKey: string;
    item: z.infer<typeof offlineQueueItemSchema>;
    reconciledBy: string;
    status: "aplicado" | "rechazado";
    resultChargeId: string | null;
    rejectionReason: string | null;
  },
): Promise<QueueRow> {
  const { rows } = await db.query<QueueRow>(
    `insert into public.fnb_offline_charge_queue
       (tenant_id, hotel_id, client_operation_id, operation_type, folio_id, original_charge_id,
        description, amount, captured_by, captured_offline_at, device_id,
        reconciled_by, reconciled_status, result_charge_id, rejection_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id, operation_type, reconciled_status, result_charge_id,
               rejection_reason, captured_offline_at::text as captured_offline_at,
               reconciled_at::text as reconciled_at;`,
    [
      params.orgId,
      params.hotelId,
      params.idempotencyKey,
      params.item.operationType,
      params.item.folioId,
      params.item.operationType === "reverso" ? params.item.originalChargeId : null,
      params.item.descripcion,
      params.item.monto,
      params.item.capturadoPor,
      params.item.capturadoOfflineEn,
      params.item.deviceId,
      params.reconciledBy,
      params.status,
      params.resultChargeId,
      params.rejectionReason,
    ],
  );
  return rows[0]!;
}

function serializeQueueRow(row: QueueRow) {
  return {
    id: row.id,
    tipo: row.operation_type,
    resultado: row.reconciled_status,
    chargeId: row.result_charge_id,
    motivoRechazo: row.rejection_reason,
    capturadoOfflineEn: row.captured_offline_at,
    reconciliadoEn: row.reconciled_at,
  };
}

export function fnbOfflineQueueRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/fnb-offline-queue*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/fnb-offline-queue", async (c) => {
    assertRole(c, OFFLINE_QUEUE_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<QueueRow>(
      `select id, operation_type, reconciled_status, result_charge_id, rejection_reason,
              captured_offline_at::text as captured_offline_at, reconciled_at::text as reconciled_at
       from public.fnb_offline_charge_queue
       where hotel_id = $1
       order by captured_offline_at desc
       limit 200;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map(serializeQueueRow));
  });

  app.post("/hoteles/:hotelId/fnb-offline-queue/reconciliar", async (c) => {
    assertRole(c, OFFLINE_QUEUE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reconciledBy = c.get("userId");
    const item = parseBody(offlineQueueItemSchema, await c.req.json().catch(() => ({})));

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "fnb.offline.reconcile", key: idempotencyKey, body: item },
      async () => {
        const domainItem: FnbOfflineQueueItemInput = {
          clientOperationId: idempotencyKey,
          operationType: item.operationType,
          folioId: item.folioId,
          originalChargeId: item.operationType === "reverso" ? (item.originalChargeId ?? null) : null,
          description: item.descripcion,
          amount: item.monto,
          capturedBy: item.capturadoPor,
          capturedOfflineAt: item.capturadoOfflineEn,
          deviceId: item.deviceId,
        };
        const shapeValidation = validateFnbOfflineQueueItem(domainItem);
        if (!shapeValidation.valid) {
          const rejected = await insertQueueRow(db, {
            orgId,
            hotelId,
            idempotencyKey,
            item,
            reconciledBy,
            status: "rechazado",
            resultChargeId: null,
            rejectionReason: shapeValidation.reasons.join(" | "),
          });
          return { status: 201, body: serializeQueueRow(rejected) };
        }

        try {
          const folio = await loadFolio(db, hotelId, item.folioId);
          if (folio.status !== "abierto") {
            throw new Error("El folio está cerrado: no admite operaciones de F&B reconciliadas.");
          }

          let resultChargeId: string;
          if (item.operationType === "reverso") {
            if (!item.motivoReverso) throw new Error("motivoReverso es requerido para operationType='reverso'.");
            if (!item.originalChargeId) throw new Error("originalChargeId es requerido para operationType='reverso'.");
            const reversal = await reverseCharge({
              db,
              orgId,
              hotelId,
              folioId: item.folioId,
              chargeId: item.originalChargeId,
              motivo: item.motivoReverso,
            });
            resultChargeId = reversal.reversalId;
          } else {
            // 'cargo': esta cola es exclusivamente de F&B (REQ-AB-003) -- siempre
            // concept='ab', por lo que SIEMPRE exige la doble verificación de
            // identidad de REQ-AB-012 (offline no es una vía para saltársela: el
            // mesero verificó en persona precisamente PORQUE no tenía señal para
            // llamar a nadie más).
            if (!item.verificacionIdentidad) {
              throw new Error("verificacionIdentidad es requerida para operationType='cargo' (REQ-AB-012).");
            }
            const taxConfig = await loadHotelMoneyConfig(db, hotelId);
            const calc = computeChargeAmounts({ concept: "ab", netAmount: item.monto, taxConfig });
            const onFile = await loadGuestForFolio(db, folio);
            const overrideAuthorizedByAdmin = item.verificacionIdentidad.autorizadoPorUserId
              ? await isAdminStaff(db, hotelId, item.verificacionIdentidad.autorizadoPorUserId)
              : false;
            const identityResult = assertRoomChargeIdentityVerified({
              claim: {
                statedSurname: item.verificacionIdentidad.apellidoConfirmado,
                statedPhoneLast4: item.verificacionIdentidad.telefonoUltimos4Confirmado,
              },
              onFile,
              overrideAuthorizedByAdmin,
            });

            const { rows } = await db.query<{ id: string }>(
              `insert into public.charge
                 (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept,
                  identity_verified_at, identity_verified_by, identity_verification_surname_stated,
                  identity_verification_phone_last4_stated, identity_verification_override_by)
               values ($1, $2, $3, $4, $5, $6, 'ab', now(), $7, $8, $9, $10)
               returning id;`,
              [
                orgId,
                hotelId,
                item.folioId,
                item.descripcion,
                calc.netAmount,
                calc.taxAmount,
                reconciledBy,
                item.verificacionIdentidad.apellidoConfirmado,
                identityResult.viaAdminOverride ? null : item.verificacionIdentidad.telefonoUltimos4Confirmado,
                identityResult.viaAdminOverride ? (item.verificacionIdentidad.autorizadoPorUserId ?? null) : null,
              ],
            );
            resultChargeId = rows[0]!.id;
            await db.query(
              "select public.record_audit_log($1, $2, 'charge.created', 'charge', $3, $4);",
              [orgId, hotelId, resultChargeId, JSON.stringify({ viaOfflineQueue: true, descripcion: item.descripcion, monto: item.monto })],
            );
          }

          const applied = await insertQueueRow(db, {
            orgId,
            hotelId,
            idempotencyKey,
            item,
            reconciledBy,
            status: "aplicado",
            resultChargeId,
            rejectionReason: null,
          });
          return { status: 201, body: serializeQueueRow(applied) };
        } catch (err) {
          const message =
            err instanceof RoomChargeIdentityBlockedError || err instanceof Error ? err.message : String(err);
          const rejected = await insertQueueRow(db, {
            orgId,
            hotelId,
            idempotencyKey,
            item,
            reconciledBy,
            status: "rechazado",
            resultChargeId: null,
            rejectionReason: message,
          });
          return { status: 201, body: serializeQueueRow(rejected) };
        }
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  return app;
}
