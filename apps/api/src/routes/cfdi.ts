// H5 · CFDI 4.0 de hospedaje (REQ-BO-001/002, H16-007) sobre `CfdiPort`
// (packages/mcp-servers/cfdi, ya construido en H9/H11 -- este archivo NO reimplementa
// el puerto, solo aplica las reglas de negocio de hospedaje y guarda el resultado en
// `cfdi_emision`). Timbrado idempotente por folio+tipo: reintentar la misma emisión
// devuelve el mismo UUID (REQ-BO-002), delegado al propio `CfdiPort` (idempotente por
// `input.folio`).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, type HotelRole } from "../domain/roles.ts";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import type { ResolvedAppDeps, HonoEnvBindings } from "../types.ts";

const CFDI_ROLES: HotelRole[] = [...ADMIN_ROLES, "accountant"];

const RFC_GENERICO_EXTRANJERO = "XEXX010101000";
const RFC_PUBLICO_GENERAL = "XAXX010101000";

const emitirHospedajeSchema = z.object({
  rfcReceptor: z.string().min(12).max(13).optional(),
  usoCfdi: z.string().min(1).optional(),
  metodoPago: z.enum(["PUE", "PPD"]).default("PUE"),
  esExtranjero: z.boolean().default(false),
  esGlobal: z.boolean().default(false),
  esNoShow: z.boolean().default(false),
  /** UUID de nuestra propia tabla `cfdi_emision` de un anticipo previo -- se traduce
   *  en `related_cfdi_id` (tipo de relación 07, "CFDI relacionado" de anticipo). El
   *  `CfdiPort` actual (packages/mcp-servers/cfdi) no expone un campo
   *  `CfdiRelacionados` en su esquema `TimbrarInput` -- la relación se registra en
   *  ESTA tabla como el mejor esfuerzo disponible sin modificar el contrato del
   *  puerto (propiedad de otro módulo, ver docs/ARQUITECTURA.md ADR-007); queda
   *  documentado como pendiente en el README de este módulo para cuando el puerto
   *  incorpore ese campo. */
  relacionadoCfdiId: z.string().uuid().optional(),
});

const emitirPagoSchema = z.object({
  paymentId: z.string().uuid(),
  relacionadoCfdiId: z.string().uuid(),
});

const cancelarSchema = z.object({
  motivo: z.enum(["01", "02", "03", "04"]),
  folioSustitucion: z.string().uuid().optional(),
});

interface ChargeSumRow {
  total_amount: string;
  tax_total: string;
  hospedaje_count: string;
}

interface CfdiEmisionRow {
  id: string;
  folio_id: string;
  tipo: string;
  uuid_fiscal: string | null;
  status: string;
  pac: string | null;
  subtotal: string;
  iva: string;
  impuestos_locales: Record<string, unknown>;
  total: string;
  rfc_receptor: string;
  uso_cfdi: string;
  metodo_pago: string;
  es_extranjero: boolean;
  es_global: boolean;
  es_no_show: boolean;
  related_cfdi_id: string | null;
  created_at: string;
  canceled_at: string | null;
}

function serializeCfdi(row: CfdiEmisionRow) {
  return {
    id: row.id,
    folioId: row.folio_id,
    tipo: row.tipo,
    uuidFiscal: row.uuid_fiscal,
    estado: row.status,
    pac: row.pac,
    subtotal: Number(row.subtotal),
    iva: Number(row.iva),
    impuestosLocales: row.impuestos_locales,
    total: Number(row.total),
    rfcReceptor: row.rfc_receptor,
    usoCfdi: row.uso_cfdi,
    metodoPago: row.metodo_pago,
    esExtranjero: row.es_extranjero,
    esGlobal: row.es_global,
    esNoShow: row.es_no_show,
    relacionadoCfdiId: row.related_cfdi_id,
    creadoEn: row.created_at,
    canceladoEn: row.canceled_at,
  };
}

export function cfdiRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/folios/:folioId/cfdi*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/cfdi*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/cfdi", async (c) => {
    assertRole(c, CFDI_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<CfdiEmisionRow>(
      `select id, folio_id, tipo, uuid_fiscal, status, pac, subtotal::text as subtotal, iva::text as iva,
              impuestos_locales, total::text as total, rfc_receptor, uso_cfdi, metodo_pago,
              es_extranjero, es_global, es_no_show, related_cfdi_id, created_at::text as created_at,
              canceled_at::text as canceled_at
       from public.cfdi_emision where hotel_id = $1 order by created_at desc limit 200;`,
      [hotelId],
    );
    return c.json(rows.map(serializeCfdi));
  });

  app.get("/hoteles/:hotelId/folios/:folioId/cfdi", async (c) => {
    assertRole(c, CFDI_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<CfdiEmisionRow>(
      `select id, folio_id, tipo, uuid_fiscal, status, pac, subtotal::text as subtotal, iva::text as iva,
              impuestos_locales, total::text as total, rfc_receptor, uso_cfdi, metodo_pago,
              es_extranjero, es_global, es_no_show, related_cfdi_id, created_at::text as created_at,
              canceled_at::text as canceled_at
       from public.cfdi_emision where folio_id = $1 and hotel_id = $2 order by created_at asc;`,
      [c.req.param("folioId"), c.req.param("hotelId")],
    );
    return c.json(rows.map(serializeCfdi));
  });

  // H5 · REQ-BO-001: timbra el CFDI de hospedaje del folio aplicando las reglas
  // específicas (extranjero/global/no-show/anticipo relacionado). Propina NUNCA entra
  // al subtotal (excluida del CFDI); los reversos ya vienen con monto negativo y
  // cancelan naturalmente al cargo original que reversaron.
  app.post("/hoteles/:hotelId/folios/:folioId/cfdi", async (c) => {
    assertRole(c, CFDI_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(emitirHospedajeSchema, await c.req.json().catch(() => ({})));

    const { rows: folioRows } = await db.query<{ id: string }>(
      "select id from public.folio where id = $1 and hotel_id = $2;",
      [folioId, hotelId],
    );
    if (folioRows.length === 0) throw Errors.notFound("Folio no encontrado.");

    // REQ-BO-002: si este folio YA tiene un CFDI de hospedaje, se devuelve tal cual
    // (mismo UUID) sin volver a llamar al PAC -- verificado ANTES de tocar
    // `withIdempotency` para que también cubra un reintento con una Idempotency-Key
    // DISTINTA (p.ej. el cliente perdió la clave original).
    const { rows: existingCfdiRows } = await db.query<CfdiEmisionRow>(
      `select id, folio_id, tipo, uuid_fiscal, status, pac, subtotal::text as subtotal, iva::text as iva,
              impuestos_locales, total::text as total, rfc_receptor, uso_cfdi, metodo_pago,
              es_extranjero, es_global, es_no_show, related_cfdi_id, created_at::text as created_at,
              canceled_at::text as canceled_at
       from public.cfdi_emision where folio_id = $1 and tipo = 'hospedaje';`,
      [folioId],
    );
    if (existingCfdiRows.length > 0) {
      return c.json(serializeCfdi(existingCfdiRows[0]!), 200);
    }

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "cfdi.hospedaje", key: idempotencyKey, body: { folioId, ...body } },
      async () => {
        const moneyConfig = await loadHotelMoneyConfig(db, hotelId);
        if (!moneyConfig.rfcEmisor) {
          throw Errors.validation("Este hotel no tiene RFC emisor configurado todavía: no se puede timbrar CFDI.");
        }

        let rfcReceptor: string;
        let usoCfdi: string;
        if (body.esExtranjero) {
          rfcReceptor = RFC_GENERICO_EXTRANJERO;
          usoCfdi = "S01";
        } else if (body.esGlobal) {
          rfcReceptor = RFC_PUBLICO_GENERAL;
          usoCfdi = "S01";
        } else {
          if (!body.rfcReceptor || !body.usoCfdi) {
            throw Errors.validation("rfcReceptor y usoCfdi son obligatorios salvo esExtranjero/esGlobal.");
          }
          rfcReceptor = body.rfcReceptor;
          usoCfdi = body.usoCfdi;
        }

        // F2/F3 · REQ-BO-001: una sola fuente de verdad para el total del CFDI -- el
        // impuesto ya se calculó y se guardó por cargo en el momento en que se posteó
        // (computeChargeAmounts/computeNoShowPenaltyAmounts, ambos ya excluyen ISH de
        // A&B/extras/no-show), así que el CFDI SUMA lo ya cobrado (`tax_amount`) en vez
        // de recalcular un impuesto nuevo desde cero sobre el subtotal agregado -- eso
        // es justo lo que producía un total de CFDI distinto al que el folio le cobró
        // al huésped (ISH indebido sobre A&B y sobre la penalidad de no-show). El
        // desglose IVA/ISH que exige el nodo fiscal del comprobante se deriva de la
        // MISMA suma ya cobrada: el IVA es 16% del subtotal completo (aplica a TODO lo
        // gravado, incluida la penalidad de no-show y A&B/extras) y el ISH es lo que
        // sobra de `tax_total` una vez restado ese IVA -- por construcción, solo queda
        // ISH ahí cuando de verdad hubo un cargo de hospedaje real con ISH incluido.
        const { rows: sumRows } = await db.query<ChargeSumRow>(
          `select coalesce(sum(amount), 0)::text as total_amount,
                  coalesce(sum(tax_amount), 0)::text as tax_total,
                  coalesce(sum(case when concept = 'hospedaje' and stay_date is not null and reversed_by is null then 1 else 0 end), 0)::text as hospedaje_count
           from public.charge
           where folio_id = $1 and concept <> 'propina';`,
          [folioId],
        );
        const subtotalBase = Number(sumRows[0]?.total_amount ?? 0);
        const taxTotal = Number(sumRows[0]?.tax_total ?? 0);
        const hospedajeNights = Number(sumRows[0]?.hospedaje_count ?? 0);

        if (subtotalBase <= 0) {
          throw Errors.conflict("El folio no tiene cargos facturables (fuera de propina) para timbrar un CFDI.");
        }

        const ivaAmount = Math.round(subtotalBase * moneyConfig.ivaRate * 100) / 100;
        const ishAmount = Math.max(0, Math.round((taxTotal - ivaAmount) * 100) / 100);
        const breakdown = { netAmount: subtotalBase, ivaAmount, ishAmount, totalAmount: subtotalBase + taxTotal };
        const dsaMonto = Math.round(hospedajeNights * moneyConfig.dsaPerNight * 100) / 100;
        const total = Math.round((breakdown.totalAmount + dsaMonto) * 100) / 100;

        // `input.folio` es la clave de idempotencia del CfdiPort (REQ-BO-002): timbrar
        // dos veces el MISMO folio con los MISMOS datos devuelve el mismo UUID sin
        // llamar de nuevo al PAC.
        const timbrado = await deps.cfdi.timbrar({
          folio: `${folioId}:hospedaje`,
          rfcEmisor: moneyConfig.rfcEmisor,
          rfcReceptor,
          subtotal: breakdown.netAmount,
          iva: breakdown.ivaAmount,
          impuestosLocales: { ishTasa: moneyConfig.ishRate, ishMonto: breakdown.ishAmount, dsaMonto },
          total,
          moneda: "MXN",
          usoCfdi,
          metodoPago: body.metodoPago,
        });

        const { rows: insertedRows } = await db.query<{ id: string }>(
          `insert into public.cfdi_emision
             (tenant_id, hotel_id, folio_id, tipo, uuid_fiscal, status, pac, subtotal, iva, impuestos_locales,
              total, rfc_receptor, uso_cfdi, metodo_pago, es_extranjero, es_global, es_no_show, related_cfdi_id)
           values ($1, $2, $3, 'hospedaje', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           on conflict (folio_id) where tipo = 'hospedaje' do nothing
           returning id;`,
          [
            orgId,
            hotelId,
            folioId,
            timbrado.uuid,
            timbrado.status,
            timbrado.pac,
            breakdown.netAmount,
            breakdown.ivaAmount,
            JSON.stringify({ ishTasa: moneyConfig.ishRate, ishMonto: breakdown.ishAmount, dsaMonto }),
            total,
            rfcReceptor,
            usoCfdi,
            body.metodoPago,
            body.esExtranjero,
            body.esGlobal,
            body.esNoShow,
            body.relacionadoCfdiId ?? null,
          ],
        );

        let cfdiId = insertedRows[0]?.id;
        if (!cfdiId) {
          const { rows: raceRows } = await db.query<{ id: string }>(
            "select id from public.cfdi_emision where folio_id = $1 and tipo = 'hospedaje';",
            [folioId],
          );
          cfdiId = raceRows[0]?.id;
        }

        await db.query(
          "select public.record_audit_log($1, $2, 'cfdi.timbrado', 'cfdi_emision', $3, $4);",
          [orgId, hotelId, cfdiId ?? null, JSON.stringify({ folioId, uuid: timbrado.uuid, total })],
        );

        return { status: 201, body: { id: cfdiId, uuidFiscal: timbrado.uuid, estado: timbrado.status, pac: timbrado.pac, total } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  // H5 · complemento de pago: CFDI tipo 'pago' que referencia el CFDI de hospedaje
  // (PPD) al que corresponde -- subtotal/IVA en $0 (el impuesto ya se declaró en el
  // CFDI original), total = monto del pago.
  app.post("/hoteles/:hotelId/folios/:folioId/cfdi/pago", async (c) => {
    assertRole(c, CFDI_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const folioId = c.req.param("folioId");
    const body = parseBody(emitirPagoSchema, await c.req.json().catch(() => ({})));

    const { rows: existingRows } = await db.query<{ id: string; uuid_fiscal: string | null; status: string; total: string }>(
      "select id, uuid_fiscal, status, total::text as total from public.cfdi_emision where payment_id = $1 and tipo = 'pago';",
      [body.paymentId],
    );
    if (existingRows.length > 0) {
      return c.json({ id: existingRows[0]!.id, uuidFiscal: existingRows[0]!.uuid_fiscal, estado: existingRows[0]!.status, total: Number(existingRows[0]!.total) }, 200);
    }

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "cfdi.pago", key: idempotencyKey, body },
      async () => {
        const { rows: paymentRows } = await db.query<{ amount: string; status: string }>(
          "select amount::text as amount, status from public.payment where id = $1 and folio_id = $2 and hotel_id = $3;",
          [body.paymentId, folioId, hotelId],
        );
        if (paymentRows.length === 0) throw Errors.notFound("Pago no encontrado en este folio.");
        if (paymentRows[0]!.status !== "capturado") throw Errors.conflict("Solo se emite complemento de pago sobre un pago capturado.");

        const { rows: relatedRows } = await db.query<{ rfc_receptor: string }>(
          "select rfc_receptor from public.cfdi_emision where id = $1 and folio_id = $2 and hotel_id = $3;",
          [body.relacionadoCfdiId, folioId, hotelId],
        );
        if (relatedRows.length === 0) throw Errors.notFound("El CFDI de hospedaje relacionado no existe en este folio.");

        const moneyConfig = await loadHotelMoneyConfig(db, hotelId);
        if (!moneyConfig.rfcEmisor) throw Errors.validation("Este hotel no tiene RFC emisor configurado todavía.");

        const total = Number(paymentRows[0]!.amount);
        const timbrado = await deps.cfdi.timbrar({
          folio: `${folioId}:pago:${body.paymentId}`,
          rfcEmisor: moneyConfig.rfcEmisor,
          rfcReceptor: relatedRows[0]!.rfc_receptor,
          subtotal: 0,
          iva: 0,
          impuestosLocales: { ishTasa: 0, ishMonto: 0 },
          total,
          moneda: "MXN",
          usoCfdi: "CP01",
          metodoPago: "PPD",
        });

        const { rows: insertedRows } = await db.query<{ id: string }>(
          `insert into public.cfdi_emision
             (tenant_id, hotel_id, folio_id, tipo, uuid_fiscal, status, pac, subtotal, iva, impuestos_locales,
              total, rfc_receptor, uso_cfdi, metodo_pago, related_cfdi_id, payment_id)
           values ($1, $2, $3, 'pago', $4, $5, $6, 0, 0, $7, $8, $9, 'CP01', 'PPD', $10, $11)
           on conflict (payment_id) where tipo = 'pago' do nothing
           returning id;`,
          [
            orgId,
            hotelId,
            folioId,
            timbrado.uuid,
            timbrado.status,
            timbrado.pac,
            JSON.stringify({ ishTasa: 0, ishMonto: 0 }),
            total,
            relatedRows[0]!.rfc_receptor,
            body.relacionadoCfdiId,
            body.paymentId,
          ],
        );

        let cfdiId = insertedRows[0]?.id;
        if (!cfdiId) {
          const { rows: raceRows } = await db.query<{ id: string }>(
            "select id from public.cfdi_emision where payment_id = $1 and tipo = 'pago';",
            [body.paymentId],
          );
          cfdiId = raceRows[0]?.id;
        }

        await db.query(
          "select public.record_audit_log($1, $2, 'cfdi.pago_timbrado', 'cfdi_emision', $3, $4);",
          [orgId, hotelId, cfdiId ?? null, JSON.stringify({ folioId, paymentId: body.paymentId, uuid: timbrado.uuid })],
        );

        return { status: 201, body: { id: cfdiId, uuidFiscal: timbrado.uuid, estado: timbrado.status, total } };
      },
    );

    return c.json(result.body as object, result.status as 201);
  });

  app.post("/hoteles/:hotelId/cfdi/:cfdiId/cancelar", async (c) => {
    assertRole(c, CFDI_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const cfdiId = c.req.param("cfdiId");
    const body = parseBody(cancelarSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ uuid_fiscal: string | null; status: string }>(
      "select uuid_fiscal, status from public.cfdi_emision where id = $1 and hotel_id = $2;",
      [cfdiId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("CFDI no encontrado.");
    if (!rows[0]!.uuid_fiscal) throw Errors.conflict("Este CFDI no tiene UUID fiscal (no fue timbrado con éxito).");
    if (rows[0]!.status === "cancelado") throw Errors.conflict("Este CFDI ya está cancelado.");

    const cancelacion = await deps.cfdi.cancelar({
      uuid: rows[0]!.uuid_fiscal,
      motivo: body.motivo,
      folioSustitucion: body.folioSustitucion,
      idempotencyKey,
    });

    await db.query(
      "update public.cfdi_emision set status = $1, canceled_at = now() where id = $2;",
      [cancelacion.status, cfdiId],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'cfdi.cancelado', 'cfdi_emision', $3, $4);",
      [orgId, hotelId, cfdiId, JSON.stringify({ motivo: body.motivo })],
    );

    return c.json({ id: cfdiId, estado: cancelacion.status });
  });

  return app;
}
