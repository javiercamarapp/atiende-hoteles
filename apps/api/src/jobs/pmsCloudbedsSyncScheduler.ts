// H15-001/ADR-007 · primer CALLER real de `@atiende-hoteles/mcp-pms` desde apps/api
// (auditoria confirmo 0 callers de produccion: `apps/api/package.json` no lo listaba
// como dependencia y nada fuera del propio paquete lo importaba). Mismo patron de
// planificador EN PROCESO que `jobs/nightAuditScheduler.ts`/
// `emailOutbox/runEmailOutboxWorker.ts` (poll con `setInterval`, parada limpia,
// `onTick`/`onError` para logging/metricas en server.ts).
//
// Punto de integracion elegido (REQ-INT-001): sincronizar tarifas (`PmsPort.
// listRatePlans`) desde Cloudbeds hacia `public.rate_plan` -- la MISMA tabla que
// `apps/api/src/pms/dbRoomRatePort.ts` ya lee para cotizar (ver README de ese
// directorio: "cuando lleguen credenciales reales de Cloudbeds, este es el paquete a
// cablear"). Se eligio sobre "consultar reservas" porque no requiere inventar un
// mapeo reservacion-propia <-> reservacion-Cloudbeds (que hoy no existe en el
// esquema); tarifas si tiene un punto de enganche minimo y ya documentado en el estilo
// del repo: `room_type.cloudbeds_room_type_id` (migracion 0125, nullable, "lista para
// cuando exista" -- mismo patron que `guest_review.external_id` de la migracion 0097).
//
// [PENDIENTE DE CREDENCIALES] Sin las 4 variables OAuth de `CloudbedsAdapter`
// (`CLOUDBEDS_CLIENT_ID`/`_CLIENT_SECRET`/`_REFRESH_TOKEN`/`_PROPERTY_ID`), cada tick
// SOLO registra `status().reason` por cada room_type mapeado -- 0 llamadas de red,
// 0 filas escritas, nunca inventa una tarifa. Con credenciales reales, sincroniza el
// rango [hoy, hoy + `horizonDays`) para cada room_type con `cloudbeds_room_type_id`.
import type { DbClient } from "@atiende-hoteles/db";
import { CloudbedsAdapter, PMS_CONNECTOR_REGISTRY, type PmsPort, type PmsRatePlan } from "@atiende-hoteles/mcp-pms";
import { PortUnavailableError } from "@atiende-hoteles/mcp-shared";

// REQ-AGT-018/GOB-059 (registro unico de conectores, `packages/mcp-servers/pms/src/
// registry.ts`): esta es una LECTURA del registro (`.find`), no una bifurcacion
// `if provider === "cloudbeds"` -- exactamente la forma que
// `scripts/checks/registro-unico-conectores.ts` documenta como el patron fomentado
// (ver su prueba "un árbol limpio... no debe marcarse"). Sirve para que, si algun dia
// Cloudbeds dejara de ser el conector PMS "implementado" del registro (por ejemplo,
// reemplazado por Mews como conector principal), este scheduler falle RUIDOSAMENTE al
// arrancar en vez de seguir asumiendo en silencio que Cloudbeds sigue siendo el
// conector vigente.
function assertCloudbedsIsTheRegisteredPmsConnector(): void {
  const entry = PMS_CONNECTOR_REGISTRY.find((e) => e.provider === "cloudbeds");
  if (!entry || entry.status !== "implementado") {
    throw new Error(
      "pmsCloudbedsSyncScheduler: 'cloudbeds' ya no figura como conector PMS implementado en " +
        "PMS_CONNECTOR_REGISTRY -- revisar packages/mcp-servers/pms/src/registry.ts antes de arrancar este job.",
    );
  }
}

export interface RoomTypeToSync {
  roomTypeId: string;
  hotelId: string;
  tenantId: string;
  cloudbedsRoomTypeId: string;
}

export interface PmsCloudbedsSyncSchedulerOptions {
  /** Dias hacia adelante que se sincronizan en cada tick, desde "hoy" (UTC). Default 14
   *  -- mismo orden de magnitud que un horizonte de disponibilidad a corto plazo,
   *  sin pretender ser un motor de revenue management completo (fuera de alcance). */
  horizonDays?: number;
  /** Puerto PMS inyectable -- SOLO para pruebas (`FakeCloudbedsAdapter` o
   *  `CloudbedsAdapter` apuntado a `cloudbeds-simulator.ts`). En produccion siempre es
   *  `new CloudbedsAdapter()` (unico conector "implementado" hoy, ver
   *  `assertCloudbedsIsTheRegisteredPmsConnector`). */
  pmsPort?: PmsPort;
  /** Reloj inyectable para pruebas deterministas del rango de fechas sincronizado. */
  now?: () => Date;
}

export interface RoomTypeSyncResult {
  roomTypeId: string;
  hotelId: string;
  cloudbedsRoomTypeId: string;
  synced: boolean;
  ratesWritten?: number;
  skippedReason?: "pms_unavailable";
  error?: string;
}

export async function loadRoomTypesForCloudbedsSync(db: DbClient): Promise<RoomTypeToSync[]> {
  const { rows } = await db.query<{ room_type_id: string; hotel_id: string; tenant_id: string; cloudbeds_room_type_id: string }>(
    `select id as room_type_id, hotel_id, tenant_id, cloudbeds_room_type_id
     from public.room_type
     where cloudbeds_room_type_id is not null
     order by id;`,
  );
  return rows.map((r) => ({
    roomTypeId: r.room_type_id,
    hotelId: r.hotel_id,
    tenantId: r.tenant_id,
    cloudbedsRoomTypeId: r.cloudbeds_room_type_id,
  }));
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function upsertRatePlan(db: DbClient, tenantId: string, hotelId: string, roomTypeId: string, rate: PmsRatePlan): Promise<void> {
  // `on conflict (room_type_id, date)`: mismo constraint unico que `packages/db/
  // migrations/0004_room_inventory.sql` ya declara para `rate_plan` -- una segunda
  // sincronizacion del mismo dia actualiza el precio en vez de duplicar la fila.
  await db.query(
    `insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price, currency)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (room_type_id, date)
     do update set price = excluded.price, currency = excluded.currency, updated_at = now();`,
    [tenantId, hotelId, roomTypeId, rate.date, rate.nightlyRate, rate.currency],
  );
}

/**
 * Un "tick": para cada `room_type` con `cloudbeds_room_type_id`, sincroniza sus
 * tarifas del rango [hoy, hoy+horizonDays) hacia `rate_plan`. Nunca lanza -- cada
 * room_type reporta su propio resultado/error (mismo criterio que
 * `NightAuditScheduler.tick`: un fallo en uno no detiene el resto).
 */
export async function runPmsCloudbedsSyncTick(
  db: DbClient,
  pmsPort: PmsPort,
  roomTypes: readonly RoomTypeToSync[],
  options: { horizonDays?: number; now?: () => Date } = {},
): Promise<RoomTypeSyncResult[]> {
  const horizonDays = options.horizonDays ?? 14;
  const now = (options.now ?? (() => new Date()))();
  const from = toDateOnly(now);
  const to = toDateOnly(new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000));

  const results: RoomTypeSyncResult[] = [];
  for (const rt of roomTypes) {
    try {
      const status = pmsPort.status();
      if (!status.available) {
        results.push({
          roomTypeId: rt.roomTypeId,
          hotelId: rt.hotelId,
          cloudbedsRoomTypeId: rt.cloudbedsRoomTypeId,
          synced: false,
          skippedReason: "pms_unavailable",
          error: status.reason,
        });
        continue;
      }
      const rates = await pmsPort.listRatePlans({ roomTypeExternalId: rt.cloudbedsRoomTypeId, from, to });
      for (const rate of rates) {
        await upsertRatePlan(db, rt.tenantId, rt.hotelId, rt.roomTypeId, rate);
      }
      results.push({
        roomTypeId: rt.roomTypeId,
        hotelId: rt.hotelId,
        cloudbedsRoomTypeId: rt.cloudbedsRoomTypeId,
        synced: true,
        ratesWritten: rates.length,
      });
    } catch (err) {
      results.push({
        roomTypeId: rt.roomTypeId,
        hotelId: rt.hotelId,
        cloudbedsRoomTypeId: rt.cloudbedsRoomTypeId,
        synced: false,
        error: err instanceof PortUnavailableError ? err.message : err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Arranca el planificador EN PROCESO (mismo patron que `startNightAuditScheduler`):
 * corre un tick de inmediato y luego cada `intervalMs` (default 30 min -- las tarifas
 * cambian con mucha menor frecuencia que el estado de una reserva individual, no hace
 * falta el intervalo de 15 min del night audit). `timer.unref()` para no bloquear un
 * apagado limpio del proceso.
 */
export function startPmsCloudbedsSyncScheduler(
  db: DbClient,
  options: PmsCloudbedsSyncSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: RoomTypeSyncResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { stop: () => void } {
  assertCloudbedsIsTheRegisteredPmsConnector();
  const pmsPort = options.pmsPort ?? new CloudbedsAdapter();
  const intervalMs = options.intervalMs ?? 30 * 60_000;

  const runOnce = () => {
    loadRoomTypesForCloudbedsSync(db)
      .then((roomTypes) => runPmsCloudbedsSyncTick(db, pmsPort, roomTypes, options))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
