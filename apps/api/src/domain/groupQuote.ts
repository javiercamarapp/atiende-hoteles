// REQ-RES-012 (P1/F): capa de datos real de la cotización de grupo/room block --
// consulta disponibilidad/tarifa reales (`dbGroupDisplacementPort.ts`), delega el
// CÁLCULO a `@atiende-hoteles/domain-hotel` (`computeGroupQuote`/`evaluateCutoffAlert`,
// mismo principio de separación que `clubSegundoViaje.ts`) y persiste el estado real en
// `public.room_block` (migración 0130).
import type { DbClient } from "@atiende-hoteles/db";
import {
  computeGroupQuote,
  evaluateCutoffAlert,
  nightsBetween,
  roomsToRelease,
  type CutoffAlertEvaluation,
  type GroupQuote,
  type NightlyDisplacement,
} from "@atiende-hoteles/domain-hotel";
import { estimateNightlyDisplacement, loadNightAvailabilitySnapshots } from "../pms/dbGroupDisplacementPort.ts";

export type RoomBlockEventType = "boda" | "evento_corporativo" | "retiro" | "otro";
export type RoomBlockStatusDb = "cotizado" | "confirmado" | "liberado" | "cancelado";

export interface RoomBlockRow {
  readonly id: string;
  readonly hotelId: string;
  readonly roomTypeId: string;
  readonly organizerName: string;
  readonly organizerEmail: string;
  readonly eventType: RoomBlockEventType;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly roomsRequested: number;
  readonly currency: string;
  readonly requestedAt: string;
  readonly quotedAt: string;
  readonly slaMinutes: number;
  readonly withinSla: boolean;
  readonly manualPrice: number;
  readonly displacementCost: number;
  readonly groupPrice: number;
  readonly nightlyDisplacement: NightlyDisplacement[];
  readonly status: RoomBlockStatusDb;
  readonly cutoffDate: string | null;
  readonly roomsPickedUp: number;
  readonly confirmedAt: string | null;
  readonly releasedAt: string | null;
}

interface RoomBlockDbRow {
  id: string;
  hotel_id: string;
  room_type_id: string;
  organizer_name: string;
  organizer_email: string;
  event_type: string;
  check_in_date: string;
  check_out_date: string;
  rooms_requested: number;
  currency: string;
  requested_at: string;
  quoted_at: string;
  sla_minutes: number;
  within_sla: boolean;
  manual_price: string;
  displacement_cost: string;
  group_price: string;
  nightly_displacement: NightlyDisplacement[];
  status: string;
  cutoff_date: string | null;
  rooms_picked_up: number;
  confirmed_at: string | null;
  released_at: string | null;
}

function mapRow(row: RoomBlockDbRow): RoomBlockRow {
  return {
    id: row.id,
    hotelId: row.hotel_id,
    roomTypeId: row.room_type_id,
    organizerName: row.organizer_name,
    organizerEmail: row.organizer_email,
    eventType: row.event_type as RoomBlockEventType,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    roomsRequested: row.rooms_requested,
    currency: row.currency,
    requestedAt: row.requested_at,
    quotedAt: row.quoted_at,
    slaMinutes: row.sla_minutes,
    withinSla: row.within_sla,
    manualPrice: Number(row.manual_price),
    displacementCost: Number(row.displacement_cost),
    groupPrice: Number(row.group_price),
    nightlyDisplacement: row.nightly_displacement,
    status: row.status as RoomBlockStatusDb,
    cutoffDate: row.cutoff_date,
    roomsPickedUp: row.rooms_picked_up,
    confirmedAt: row.confirmed_at,
    releasedAt: row.released_at,
  };
}

const ROOM_BLOCK_COLUMNS = `id, hotel_id, room_type_id, organizer_name, organizer_email, event_type,
   check_in_date::text as check_in_date, check_out_date::text as check_out_date, rooms_requested, currency,
   requested_at::text as requested_at, quoted_at::text as quoted_at, sla_minutes, within_sla,
   manual_price, displacement_cost, group_price, nightly_displacement,
   status, cutoff_date::text as cutoff_date, rooms_picked_up, confirmed_at::text as confirmed_at, released_at::text as released_at`;

export interface CreateGroupQuoteParams {
  readonly hotelId: string;
  readonly tenantId: string;
  readonly createdBy: string | null;
  readonly roomTypeId: string;
  readonly organizerName: string;
  readonly organizerEmail: string;
  readonly eventType: RoomBlockEventType;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly roomsRequested: number;
  readonly manualPrice: number;
  readonly currency: string;
  readonly cutoffDate: string | null;
  /** Momento real en que llegó la solicitud (email/WhatsApp/formulario/llamada) --
   *  si no se provee, se asume que la solicitud llegó AHORA MISMO (ej. un canal
   *  conversacional que cotiza en el momento). */
  readonly requestedAt?: Date;
}

/**
 * Genera y persiste una cotización de grupo REAL: consulta disponibilidad/tarifa
 * reales (nunca inventadas), consulta al motor de Revenue el desplazamiento de ADR de
 * CADA noche (H02-015, obligatorio -- `computeGroupQuote` rechaza cualquier noche sin
 * esa consulta) y calcula el precio final. `requestedAt`/`quotedAt` son timestamps
 * reales de reloj (H02-013: "<15 minutos desde la solicitud") -- este es el ÚNICO
 * lugar del sistema que puede fijarlos, nunca un valor que el cliente HTTP envíe.
 */
export async function createGroupQuote(db: DbClient, params: CreateGroupQuoteParams): Promise<{ result: GroupQuote; row: RoomBlockRow }> {
  const requestedAt = params.requestedAt ?? new Date();
  const nights = nightsBetween(params.checkInDate, params.checkOutDate);

  const snapshots = await loadNightAvailabilitySnapshots(db, {
    hotelId: params.hotelId,
    roomTypeId: params.roomTypeId,
    nights,
  });
  const nightlyDisplacement = estimateNightlyDisplacement(snapshots, params.roomsRequested);

  // La cotización se calcula justo AHORA -- `quotedAt` se toma después de la consulta
  // real al motor de Revenue (arriba), nunca antes, para que el SLA medido sea el
  // tiempo real de principio a fin de la operación.
  const quotedAt = new Date();

  const result = computeGroupQuote({
    requestedAt: requestedAt.toISOString(),
    quotedAt: quotedAt.toISOString(),
    checkInDate: params.checkInDate,
    checkOutDate: params.checkOutDate,
    currency: params.currency,
    roomsRequested: params.roomsRequested,
    manualPrice: params.manualPrice,
    nightlyDisplacement,
  });

  const { rows } = await db.query<RoomBlockDbRow>(
    `insert into public.room_block
       (tenant_id, hotel_id, room_type_id, created_by, organizer_name, organizer_email, event_type,
        check_in_date, check_out_date, rooms_requested, currency,
        requested_at, quoted_at, sla_minutes, within_sla,
        manual_price, displacement_cost, group_price, nightly_displacement, cutoff_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20)
     returning ${ROOM_BLOCK_COLUMNS};`,
    [
      params.tenantId,
      params.hotelId,
      params.roomTypeId,
      params.createdBy,
      params.organizerName,
      params.organizerEmail,
      params.eventType,
      params.checkInDate,
      params.checkOutDate,
      params.roomsRequested,
      params.currency,
      requestedAt.toISOString(),
      quotedAt.toISOString(),
      result.slaMinutes,
      result.withinSla,
      result.manualPrice,
      result.displacementCost,
      result.groupPrice,
      JSON.stringify(result.nightlyDisplacement),
      params.cutoffDate,
    ],
  );

  return { result, row: mapRow(rows[0]!) };
}

export async function loadRoomBlock(db: DbClient, hotelId: string, id: string): Promise<RoomBlockRow | null> {
  const { rows } = await db.query<RoomBlockDbRow>(
    `select ${ROOM_BLOCK_COLUMNS} from public.room_block where id = $1 and hotel_id = $2;`,
    [id, hotelId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export class RoomBlockTransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RoomBlockTransitionError";
    this.code = code;
  }
}

/**
 * Confirma el bloque: el grupo aceptó la cotización, así que AHORA se bloquea el
 * inventario REAL (`book_availability` por cada noche, mismo advisory lock que una
 * reserva individual, REQ-RES-007) -- antes de esto, una cotización nunca toca
 * `availability` (H02-016: "al confirmarse un grupo... se registra el bloqueo en el
 * PMS"). Solo se puede confirmar una vez (`cotizado -> confirmado`); confirmar dos
 * veces bloquearía el doble de inventario.
 */
export async function confirmRoomBlock(db: DbClient, hotelId: string, id: string): Promise<RoomBlockRow> {
  const block = await loadRoomBlock(db, hotelId, id);
  if (!block) throw new RoomBlockTransitionError("no_encontrado", "Room block no encontrado.");
  if (block.status !== "cotizado") {
    throw new RoomBlockTransitionError("transicion_invalida", `Solo un room block en estado "cotizado" puede confirmarse (estado actual: "${block.status}").`);
  }

  const nights = nightsBetween(block.checkInDate, block.checkOutDate);
  for (const night of nights) {
    // `book_availability` lanza `sin_disponibilidad` (P0001, mapeado a 409 por
    // toErrorBody) si el inventario cambió entre la cotización y la confirmación --
    // una confirmación nunca bloquea "a ciegas" más de lo que en verdad queda libre.
    await db.query("select * from public.book_availability($1, $2, $3, $4);", [hotelId, block.roomTypeId, night, block.roomsRequested]);
  }

  const { rows } = await db.query<RoomBlockDbRow>(
    `update public.room_block set status = 'confirmado', confirmed_at = now(), updated_at = now()
     where id = $1 returning ${ROOM_BLOCK_COLUMNS};`,
    [id],
  );
  return mapRow(rows[0]!);
}

/**
 * Libera el bloque (cut-off vencido sin pickup completo, o cancelación del grupo antes
 * del cut-off): devuelve a `availability` exactamente lo que quedó SIN recoger
 * (`roomsToRelease`, domain-hotel/src/reservas/roomBlock.ts) -- nunca todo el bloque si
 * ya hubo pickup parcial. Solo aplica a un bloque `confirmado` (uno `cotizado` nunca
 * tocó inventario, nada que liberar).
 */
export async function releaseRoomBlock(
  db: DbClient,
  hotelId: string,
  id: string,
  finalStatus: "liberado" | "cancelado",
): Promise<RoomBlockRow> {
  const block = await loadRoomBlock(db, hotelId, id);
  if (!block) throw new RoomBlockTransitionError("no_encontrado", "Room block no encontrado.");
  if (block.status !== "confirmado") {
    throw new RoomBlockTransitionError("transicion_invalida", `Solo un room block "confirmado" puede liberarse/cancelarse (estado actual: "${block.status}").`);
  }

  const toRelease = roomsToRelease(block.roomsRequested, block.roomsPickedUp);
  if (toRelease > 0) {
    const nights = nightsBetween(block.checkInDate, block.checkOutDate);
    for (const night of nights) {
      await db.query("select * from public.release_availability($1, $2, $3, $4);", [hotelId, block.roomTypeId, night, toRelease]);
    }
  }

  const { rows } = await db.query<RoomBlockDbRow>(
    `update public.room_block set status = $2, released_at = now(), updated_at = now()
     where id = $1 returning ${ROOM_BLOCK_COLUMNS};`,
    [id, finalStatus],
  );
  return mapRow(rows[0]!);
}

/** H05-013: registra pickup real (habitaciones del bloque ya recogidas por reservas
 *  individuales confirmadas del grupo) -- staff lo reporta explícitamente; este
 *  repositorio no ata todavía una reserva individual a un `room_block` (fuera de
 *  alcance de este cierre, ver comentario de archivo de la migración 0130). */
export async function updateRoomBlockPickup(db: DbClient, hotelId: string, id: string, roomsPickedUp: number): Promise<RoomBlockRow> {
  const block = await loadRoomBlock(db, hotelId, id);
  if (!block) throw new RoomBlockTransitionError("no_encontrado", "Room block no encontrado.");
  if (roomsPickedUp > block.roomsRequested) {
    throw new RoomBlockTransitionError(
      "pickup_excede_bloqueo",
      `roomsPickedUp (${roomsPickedUp}) no puede exceder rooms_requested (${block.roomsRequested}).`,
    );
  }
  const { rows } = await db.query<RoomBlockDbRow>(
    `update public.room_block set rooms_picked_up = $2, updated_at = now() where id = $1 returning ${ROOM_BLOCK_COLUMNS};`,
    [id, roomsPickedUp],
  );
  return mapRow(rows[0]!);
}

/** H05-013: evalúa la alerta de cut-off de un bloque `confirmado` a partir de su
 *  pickup real y la fecha de hoy (`asOfDate`, siempre `current_date` de Postgres bajo
 *  esta sesión -- mismo criterio de zona horaria que `seed.ts`, nunca `Date.now()` del
 *  proceso Node). */
export async function evaluateRoomBlockCutoff(db: DbClient, hotelId: string, id: string): Promise<CutoffAlertEvaluation> {
  const block = await loadRoomBlock(db, hotelId, id);
  if (!block) throw new RoomBlockTransitionError("no_encontrado", "Room block no encontrado.");
  if (!block.cutoffDate) {
    throw new RoomBlockTransitionError("sin_cutoff", "Este room block no tiene fecha de cut-off configurada.");
  }
  const { rows } = await db.query<{ hoy: string }>("select current_date::text as hoy;");
  return evaluateCutoffAlert({
    roomsBlocked: block.roomsRequested,
    roomsPickedUp: block.roomsPickedUp,
    cutoffDate: block.cutoffDate,
    asOfDate: rows[0]!.hoy,
  });
}
