// REQ-HUE-024 · "El sistema debe registrar y consultar un consent ledger multi-país
// antes de cualquier comunicación outbound de marketing/upsell."
//
// El bloqueo de envío de plantillas de marketing sin consentimiento vigente ya existe
// (`isMarketingSendBlocked`, packages/agent-core/src/tools/messagingTools.ts, REQ-HUE-
// 021/REQ-SEG-007) -- esta ruta NO lo toca. Lo que faltaba, confirmado con
// `grep -rn "record_consent(" apps/`: ninguna ruta real permitía REGISTRAR un
// consentimiento de MARKETING (solo `checkinOnline.ts` para `tratamiento_datos`); los
// tests que ejercitan el gate insertaban la fila `consent` directo con el cliente admin,
// un atajo de prueba, no un camino de producción. Esta ruta cierra ese hueco y agrega
// la consulta del ledger anotada con jurisdicción (@atiende-hoteles/domain-hotel
// `consentLedger.ts`) que el requisito pide poder "consultar" por país.
import { Hono } from "hono";
import { z } from "zod";
import {
  annotateConsentLedger,
  consentChannelSchema,
  consentKindSchema,
  filterConsentLedger,
  resolveConsentJurisdiction,
  summarizeConsentLedger,
  CONSENT_JURISDICTIONS,
  type ConsentLedgerRow,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const registrarConsentimientoSchema = z.object({
  consentKind: consentKindSchema,
  channel: consentChannelSchema,
  granted: z.boolean(),
  avisoVersion: z.string().trim().min(1).max(60),
  reservationId: z.string().uuid().optional(),
});

interface ConsentRow {
  id: string;
  guest_id: string | null;
  channel: string;
  consent_kind: string;
  aviso_version: string;
  granted: boolean;
  created_at: string;
}

function toLedgerRow(row: ConsentRow & { guest_phone: string | null }): ConsentLedgerRow {
  return {
    id: row.id,
    guestId: row.guest_id,
    guestPhone: row.guest_phone,
    channel: row.channel as ConsentLedgerRow["channel"],
    consentKind: row.consent_kind as ConsentLedgerRow["consentKind"],
    avisoVersion: row.aviso_version,
    granted: row.granted,
    createdAt: row.created_at,
  };
}

export function consentimientoRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/huespedes/:guestId/consentimiento",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/consentimiento/ledger",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Registrar (quien atiende al huésped -- frontdesk/reservations/gm/owner, mismo
  // criterio de rol que el resto de acciones sobre datos de un huésped puntual, ver
  // huespedes.ts) el consentimiento de un huésped identificado, con la jurisdicción
  // derivada de su teléfono devuelta en la respuesta para que quien registra vea de
  // inmediato bajo qué régimen quedó clasificado.
  app.post("/hoteles/:hotelId/huespedes/:guestId/consentimiento", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const guestId = c.req.param("guestId");
    const body = parseBody(registrarConsentimientoSchema, await c.req.json().catch(() => ({})));

    const { rows: guestRows } = await db.query<{ id: string; phone: string | null }>(
      "select id, phone from public.guest where id = $1 and hotel_id = $2;",
      [guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado.");

    let row: ConsentRow;
    try {
      const { rows } = await db.query<ConsentRow>(
        `select id, guest_id, channel::text as channel, consent_kind::text as consent_kind,
                aviso_version, granted, created_at::text as created_at
         from public.record_consent($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          orgId,
          hotelId,
          body.reservationId ?? null,
          guestId,
          body.channel,
          body.consentKind,
          body.avisoVersion,
          body.granted,
        ],
      );
      row = rows[0]!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/aviso_version_requerida/.test(message)) throw Errors.validation("Se requiere la versión del aviso aceptado.");
      throw err;
    }

    return c.json(
      {
        ...toLedgerRow({ ...row, guest_phone: guestRows[0]!.phone }),
        jurisdiccion: resolveConsentJurisdiction(guestRows[0]!.phone),
      },
      201,
    );
  });

  // Consultar el ledger (owner/gm únicamente -- es un reporte de cumplimiento, no una
  // operación del día a día del huésped): filtrable por jurisdicción y/o tipo, con un
  // resumen agregado por (jurisdicción, tipo) para responder "¿cuántos consentimientos
  // de marketing vigentes tengo por país?" sin leer fila por fila.
  app.get("/hoteles/:hotelId/consentimiento/ledger", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const jurisdiccionParam = c.req.query("jurisdiccion");
    const tipoParam = c.req.query("tipo");

    if (jurisdiccionParam && !(CONSENT_JURISDICTIONS as readonly string[]).includes(jurisdiccionParam)) {
      throw Errors.validation(`jurisdiccion inválida (esperada una de: ${CONSENT_JURISDICTIONS.join(", ")}).`);
    }
    const tipoParsed = tipoParam ? consentKindSchema.safeParse(tipoParam) : null;
    if (tipoParam && !tipoParsed?.success) throw Errors.validation("tipo debe ser 'tratamiento_datos' o 'marketing'.");

    const { rows } = await db.query<ConsentRow & { guest_phone: string | null }>(
      `select co.id, co.guest_id, co.channel::text as channel, co.consent_kind::text as consent_kind,
              co.aviso_version, co.granted, co.created_at::text as created_at, g.phone as guest_phone
       from public.consent co
       left join public.guest g on g.id = co.guest_id
       where co.hotel_id = $1
       order by co.created_at desc;`,
      [hotelId],
    );

    const anotado = annotateConsentLedger(rows.map(toLedgerRow));
    const filtrado = filterConsentLedger(anotado, {
      jurisdiction: jurisdiccionParam as (typeof CONSENT_JURISDICTIONS)[number] | undefined,
      consentKind: tipoParsed?.success ? tipoParsed.data : undefined,
    });

    return c.json({
      ledger: filtrado.map((e) => ({
        id: e.id,
        guestId: e.guestId,
        canal: e.channel,
        tipo: e.consentKind,
        avisoVersion: e.avisoVersion,
        otorgado: e.granted,
        creadoEn: e.createdAt,
        jurisdiccion: e.jurisdiction,
      })),
      resumen: summarizeConsentLedger(filtrado),
    });
  });

  return app;
}
