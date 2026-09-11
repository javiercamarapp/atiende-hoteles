// REQ-AB-005 (P2/F) · /hoteles/:hotelId/folios/:folioId/minibar y
// /hoteles/:hotelId/minibar/*: consumo de minibar/honor bar SIEMPRE respaldado por
// foto o checklist asociado al cargo real del folio (nunca un cargo "a ciegas"), más
// el ciclo de disputa/resolución y el reporte periódico de tasa de disputas que exige
// el criterio de aceptación ("<3%").
//
// Motor de montos SIEMPRE en @atiende-hoteles/domain-hotel (computeChargeAmounts,
// igual que apps/api/src/routes/folios.ts) -- ningún cálculo de dinero vive aquí ni se
// delega a un LLM (ADR-006). La evidencia SIEMPRE se valida con
// `assertMinibarEvidencePresent` ANTES de insertar nada -- si trueca, ni el cargo ni
// la fila de evidencia se crean (mismo patrón fail-before-write que
// pedidosFnb.ts#asegurar-seguridad).
//
// Acceso: exactamente `can_access_money` (0007_folio.sql) -- housekeeping/maintenance
// quedan excluidos aquí igual que de folio/charge, aunque housekeeping suela ser quien
// detecta el consumo real (ver comentario de la migración 0130_minibar_consumption.sql
// sobre por qué eso es una decisión de producto deliberadamente fuera de alcance de
// este requisito P2).
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  computeChargeAmounts,
  assertMinibarEvidencePresent,
  MinibarEvidenceMissingError,
  computeMinibarDisputeRate,
  type MinibarEvidenceType,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MONEY_ROLES } from "../domain/roles.ts";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

const checklistItemSchema = z.object({
  item: z.string().trim().min(1).max(120),
  cantidad: z.number().int().positive().max(999),
});

const registrarSchema = z.object({
  roomId: z.string().uuid().optional().nullable(),
  descripcion: z.string().trim().min(1).max(300).default("Consumo de minibar/honor bar"),
  monto: z.number().positive(),
  tipoEvidencia: z.enum(["foto", "checklist"]),
  fotoUrl: z.string().trim().max(2000).optional().nullable(),
  checklistItems: z.array(checklistItemSchema).max(50).optional().nullable(),
});

const disputaSchema = z.object({
  motivo: z.string().trim().min(1).max(500),
});

const resolverDisputaSchema = z.object({
  resolucion: z.enum(["procede", "improcede"]),
  nota: z.string().trim().max(500).optional(),
});

interface MinibarRow {
  id: string;
  charge_id: string;
  folio_id: string | null;
  room_id: string | null;
  evidence_type: MinibarEvidenceType;
  photo_url: string | null;
  checklist: unknown;
  registered_by: string | null;
  registered_at: string;
  disputed_at: string | null;
  disputed_reason: string | null;
  dispute_resolution: "procede" | "improcede" | null;
  dispute_resolved_at: string | null;
}

function serializeMinibar(row: MinibarRow) {
  return {
    id: row.id,
    chargeId: row.charge_id,
    folioId: row.folio_id,
    roomId: row.room_id,
    tipoEvidencia: row.evidence_type,
    fotoUrl: row.photo_url,
    checklist: row.checklist,
    registradoPor: row.registered_by,
    registradoEn: row.registered_at,
    disputadoEn: row.disputed_at,
    motivoDisputa: row.disputed_reason,
    resolucionDisputa: row.dispute_resolution,
    disputaResueltaEn: row.dispute_resolved_at,
  };
}

async function loadFolioAbierto(db: DbClient, hotelId: string, folioId: string): Promise<{ id: string; status: string }> {
  const { rows } = await db.query<{ id: string; status: string }>(
    "select id, status from public.folio where id = $1 and hotel_id = $2;",
    [folioId, hotelId],
  );
  if (rows.length === 0) throw Errors.notFound("Folio no encontrado.");
  return rows[0]!;
}

async function loadMinibar(db: DbClient, hotelId: string, consumptionId: string): Promise<MinibarRow & { folio_status: string }> {
  const { rows } = await db.query<MinibarRow & { folio_status: string }>(
    `select mc.id, mc.charge_id, ch.folio_id, mc.room_id, mc.evidence_type, mc.photo_url, mc.checklist,
            mc.registered_by, mc.registered_at::text as registered_at,
            mc.disputed_at::text as disputed_at, mc.disputed_reason, mc.dispute_resolution,
            mc.dispute_resolved_at::text as dispute_resolved_at, f.status as folio_status
     from public.minibar_consumption mc
     join public.charge ch on ch.id = mc.charge_id
     join public.folio f on f.id = ch.folio_id
     where mc.id = $1 and mc.hotel_id = $2;`,
    [consumptionId, hotelId],
  );
  if (rows.length === 0) throw Errors.notFound("Consumo de minibar no encontrado.");
  return rows[0]!;
}

export function minibarRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/folios/:folioId/minibar",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/minibar/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Lista los consumos de minibar de un folio (evidencia visible para resolver dudas
  // ANTES de que escalen a disputa).
  app.get("/hoteles/:hotelId/folios/:folioId/minibar", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<MinibarRow>(
      `select mc.id, mc.charge_id, ch.folio_id, mc.room_id, mc.evidence_type, mc.photo_url, mc.checklist,
              mc.registered_by, mc.registered_at::text as registered_at,
              mc.disputed_at::text as disputed_at, mc.disputed_reason, mc.dispute_resolution,
              mc.dispute_resolved_at::text as dispute_resolved_at
       from public.minibar_consumption mc
       join public.charge ch on ch.id = mc.charge_id
       where ch.folio_id = $1 and mc.hotel_id = $2
       order by mc.registered_at desc;`,
      [c.req.param("folioId"), c.req.param("hotelId")],
    );
    return c.json(rows.map(serializeMinibar));
  });

  // Registra un consumo de minibar: crea el CARGO real del folio y su fila de
  // evidencia en la MISMA transacción de sesión (ADR-004) -- si la evidencia no es
  // válida, `assertMinibarEvidencePresent` truena ANTES del primer INSERT, así que
  // nunca queda un cargo sin su evidencia ni una evidencia sin su cargo.
  app.post("/hoteles/:hotelId/folios/:folioId/minibar", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(registrarSchema, await c.req.json().catch(() => ({})));

    const folio = await loadFolioAbierto(db, hotelId, folioId);
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos cargos de minibar.");

    try {
      assertMinibarEvidencePresent({
        type: body.tipoEvidencia,
        photoUrl: body.fotoUrl,
        checklistItems: body.checklistItems,
      });
    } catch (err) {
      if (err instanceof MinibarEvidenceMissingError) throw Errors.validation(err.message);
      throw err;
    }

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "minibar.registrar", key: idempotencyKey, body },
      async () => {
        const taxConfig = await loadHotelMoneyConfig(db, hotelId);
        // Minibar es consumo de A&B: mismo concepto/tratamiento fiscal que un cargo de
        // F&B normal (IVA sí, ISH no -- ver ISH_APPLICABLE_CONCEPTS en folioEngine.ts).
        const calc = computeChargeAmounts({ concept: "ab", netAmount: body.monto, taxConfig });

        const { rows: chargeRows } = await db.query<{ id: string }>(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
           values ($1, $2, $3, $4, $5, $6, 'ab')
           returning id;`,
          [orgId, hotelId, folioId, body.descripcion, calc.netAmount, calc.taxAmount],
        );
        const chargeId = chargeRows[0]!.id;

        const { rows: minibarRows } = await db.query<MinibarRow>(
          `insert into public.minibar_consumption
             (tenant_id, hotel_id, charge_id, room_id, evidence_type, photo_url, checklist, registered_by)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           returning id, charge_id, $9::uuid as folio_id, room_id, evidence_type, photo_url, checklist,
                     registered_by, registered_at::text as registered_at,
                     disputed_at::text as disputed_at, disputed_reason, dispute_resolution,
                     dispute_resolved_at::text as dispute_resolved_at;`,
          [
            orgId,
            hotelId,
            chargeId,
            body.roomId ?? null,
            body.tipoEvidencia,
            body.tipoEvidencia === "foto" ? body.fotoUrl!.trim() : null,
            body.tipoEvidencia === "checklist" ? JSON.stringify(body.checklistItems) : null,
            c.get("userId"),
            folioId,
          ],
        );
        const row = minibarRows[0]!;

        await db.query(
          "select public.record_audit_log($1, $2, 'minibar.registrado', 'minibar_consumption', $3, $4);",
          [orgId, hotelId, row.id, JSON.stringify({ chargeId, tipoEvidencia: body.tipoEvidencia, monto: calc.netAmount })],
        );

        return { status: 201, body: serializeMinibar(row) };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // Un huésped disputa el cargo (frontdesk/fnb la registra en su nombre, mismo patrón
  // que "tomar el pedido" en pedidosFnb.ts) -- no se permite abrir una segunda disputa
  // sobre un consumo que ya tiene una abierta o resuelta (evidencia auditable de que
  // el ciclo ya corrió una vez).
  app.post("/hoteles/:hotelId/minibar/:consumptionId/disputa", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const consumptionId = c.req.param("consumptionId");
    const body = parseBody(disputaSchema, await c.req.json().catch(() => ({})));

    const existing = await loadMinibar(db, hotelId, consumptionId);
    if (existing.disputed_at) throw Errors.conflict("Este consumo de minibar ya tiene una disputa registrada.");

    const { rows } = await db.query<MinibarRow>(
      `update public.minibar_consumption mc
       set disputed_at = now(), disputed_reason = $1, updated_at = now()
       from public.charge ch
       where mc.id = $2 and mc.hotel_id = $3 and ch.id = mc.charge_id
       returning mc.id, mc.charge_id, ch.folio_id, mc.room_id, mc.evidence_type, mc.photo_url, mc.checklist,
                 mc.registered_by, mc.registered_at::text as registered_at,
                 mc.disputed_at::text as disputed_at, mc.disputed_reason, mc.dispute_resolution,
                 mc.dispute_resolved_at::text as dispute_resolved_at;`,
      [body.motivo, consumptionId, hotelId],
    );
    const row = rows[0]!;

    await db.query(
      "select public.record_audit_log($1, $2, 'minibar.disputado', 'minibar_consumption', $3, $4);",
      [orgId, hotelId, consumptionId, JSON.stringify({ motivo: body.motivo })],
    );

    return c.json(serializeMinibar(row));
  });

  // Resuelve la disputa. 'procede' (el huésped tenía razón) reversa el cargo original
  // con el MISMO mecanismo ya existente de folios.ts/mark_charge_reversed() -- este
  // módulo no reimplementa el reverso, solo lo dispara cuando corresponde.
  // 'improcede' deja el cargo tal cual, solo registra la resolución.
  app.post("/hoteles/:hotelId/minibar/:consumptionId/resolver-disputa", async (c) => {
    assertRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const consumptionId = c.req.param("consumptionId");
    const body = parseBody(resolverDisputaSchema, await c.req.json().catch(() => ({})));

    const existing = await loadMinibar(db, hotelId, consumptionId);
    if (!existing.disputed_at) throw Errors.conflict("Este consumo de minibar no tiene una disputa abierta.");
    if (existing.dispute_resolution) throw Errors.conflict("Esta disputa ya fue resuelta anteriormente.");

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "minibar.resolver_disputa", key: idempotencyKey, body: { consumptionId, ...body } },
      async () => {
        if (body.resolucion === "procede") {
          if (existing.folio_status !== "abierto") {
            throw Errors.conflict("El folio de este cargo está cerrado: no se puede reversar automáticamente.");
          }
          const { rows: chargeRows } = await db.query<{ id: string; description: string; amount: string; tax_amount: string; reversed_by: string | null }>(
            "select id, description, amount, tax_amount, reversed_by from public.charge where id = $1;",
            [existing.charge_id],
          );
          const charge = chargeRows[0];
          if (!charge) throw Errors.notFound("Cargo original de minibar no encontrado.");
          if (charge.reversed_by) throw Errors.conflict("El cargo de minibar ya había sido reversado antes de resolver la disputa.");

          const { rows: reversalRows } = await db.query<{ id: string }>(
            `insert into public.charge
               (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
             values ($1, $2, $3, $4, $5, $6, 'reverso', $7)
             returning id;`,
            [
              orgId,
              hotelId,
              existing.folio_id,
              `Reverso por disputa procedente: ${charge.description}`,
              -Number(charge.amount),
              -Number(charge.tax_amount),
              charge.id,
            ],
          );
          await db.query("select public.mark_charge_reversed($1, $2);", [charge.id, reversalRows[0]!.id]);
        }

        const { rows } = await db.query<MinibarRow>(
          `update public.minibar_consumption mc
           set dispute_resolution = $1, dispute_resolved_by = $2, dispute_resolved_at = now(), updated_at = now()
           from public.charge ch
           where mc.id = $3 and mc.hotel_id = $4 and ch.id = mc.charge_id
           returning mc.id, mc.charge_id, ch.folio_id, mc.room_id, mc.evidence_type, mc.photo_url, mc.checklist,
                     mc.registered_by, mc.registered_at::text as registered_at,
                     mc.disputed_at::text as disputed_at, mc.disputed_reason, mc.dispute_resolution,
                     mc.dispute_resolved_at::text as dispute_resolved_at;`,
          [body.resolucion, c.get("userId"), consumptionId, hotelId],
        );
        const row = rows[0]!;

        await db.query(
          "select public.record_audit_log($1, $2, 'minibar.disputa_resuelta', 'minibar_consumption', $3, $4);",
          [orgId, hotelId, consumptionId, JSON.stringify({ resolucion: body.resolucion })],
        );

        return { status: 200, body: serializeMinibar(row) };
      },
    );

    return c.json(result.body as object, result.status as 200);
  });

  // Reporte periódico de tasa de disputas (segunda mitad del criterio de aceptación de
  // REQ-AB-005): `desde`/`hasta` acotan `registered_at` (ISO date, ambos opcionales --
  // sin filtro, cubre todo el histórico del hotel). Nunca fabrica un "0% cumple" sin
  // consumos registrados en el periodo -- ver `sinDatos` en `computeMinibarDisputeRate`.
  app.get("/hoteles/:hotelId/minibar/reporte-disputas", async (c) => {
    assertRole(c, MONEY_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const desde = c.req.query("desde") ?? null;
    const hasta = c.req.query("hasta") ?? null;

    const { rows } = await db.query<{ total_registrados: string; total_disputados: string }>(
      `select
         count(*)::text as total_registrados,
         count(*) filter (where disputed_at is not null)::text as total_disputados
       from public.minibar_consumption
       where hotel_id = $1
         and ($2::timestamptz is null or registered_at >= $2::timestamptz)
         and ($3::timestamptz is null or registered_at < $3::timestamptz);`,
      [hotelId, desde, hasta],
    );
    const row = rows[0]!;
    const reporte = computeMinibarDisputeRate({
      totalRegistrados: Number(row.total_registrados),
      totalDisputados: Number(row.total_disputados),
    });

    return c.json({
      desde,
      hasta,
      totalRegistrados: reporte.totalRegistrados,
      totalDisputados: reporte.totalDisputados,
      tasaDisputasPercent: reporte.ratePercent,
      umbralObjetivoPercent: reporte.thresholdPercent,
      dentroDelUmbral: reporte.dentroDelUmbral,
      sinDatos: reporte.sinDatos,
    });
  });

  return app;
}
