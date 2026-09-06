// auditoria-2/legal [ALTO]: planificador EN PROCESO de la purga de conversation/message
// por hotel (ver jobs/purgeConversations.ts) -- mismo patrón que
// jobs/purgeIdentityVaultScheduler.ts (lock por hotel en memoria, log/métrica por
// corrida, arrancado desde server.ts).
import type { DbClient } from "@atiende-hoteles/db";
import { purgeExpiredConversations, type PurgeConversationsResult } from "./purgeConversations.ts";

export interface HotelForConversationPurge {
  id: string;
  tenantId: string;
  conversationRetentionDays: number | null;
}

export interface ConversationPurgeTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: PurgeConversationsResult;
  error?: string;
}

export interface ConversationPurgeSchedulerOptions {
  batchSize?: number;
  onHotelResult?: (hotelId: string, result: PurgeConversationsResult) => void;
}

export class ConversationPurgeScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: ConversationPurgeSchedulerOptions;

  constructor(db: DbClient, options: ConversationPurgeSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForConversationPurge[]): Promise<ConversationPurgeTickResult[]> {
    const results: ConversationPurgeTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await purgeExpiredConversations(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId, retentionDays: hotel.conversationRetentionDays },
          { batchSize: this.options.batchSize },
        );
        this.options.onHotelResult?.(hotel.id, result);
        results.push({ hotelId: hotel.id, ran: true, result });
      } catch (err) {
        results.push({ hotelId: hotel.id, ran: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.inFlight.delete(hotel.id);
      }
    }

    return results;
  }
}

export async function loadHotelsForConversationPurge(db: DbClient): Promise<HotelForConversationPurge[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string; conversation_retention_days: number | null }>(
    `select h.id, h.org_id as tenant_id, mc.conversation_retention_days
     from public.hotel h
     left join public.hotel_messaging_config mc on mc.hotel_id = h.id
     order by h.id;`,
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, conversationRetentionDays: r.conversation_retention_days }));
}

export function startConversationPurgeScheduler(
  db: DbClient,
  options: ConversationPurgeSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: ConversationPurgeTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: ConversationPurgeScheduler; stop: () => void } {
  const scheduler = new ConversationPurgeScheduler(db, options);
  const intervalMs = options.intervalMs ?? 24 * 60 * 60_000; // una vez al día basta

  const runOnce = () => {
    loadHotelsForConversationPurge(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
