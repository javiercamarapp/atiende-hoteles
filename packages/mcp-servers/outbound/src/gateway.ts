/**
 * `OutboundTaskSyncGateway` -- combina la configuración por hotel
 * (`hotel_pms_outbound_config`, `packages/db/migrations/0129_hotel_pms_outbound_config.sql`)
 * con el `OutboundTaskSyncPort` (real o Fake) para decidir, tarea por tarea, si hay que
 * empujarla y a dónde. Vive en este paquete (no en `agent-core`, H6a) porque conoce el
 * NOMBRE de la tabla/columnas reales -- `agent-core` solo conoce la forma estructural
 * mínima `OutboundTaskSyncLike` (`packages/agent-core/src/tools/outboundTaskSync.ts`),
 * que este gateway cumple sin adaptador (mismo patrón `WhatsappSenderLike`).
 *
 * Usa una conexión SIN RLS (`engine.admin`, inyectada por quien construye el gateway en
 * `apps/api`) a propósito: decidir si ESTE proceso debe reenviar una tarea al sistema
 * enterprise del hotel es una decisión INTERNA del sistema -- nunca debe depender del
 * rol del staff que disparó la creación de la tarea (housekeeping, frontdesk, o el
 * agente conversacional sin sesión de staff real), igual que `PostgresApprovalQueue` y
 * los planificadores de este repo (`ticketEscalation.ts`, `nightAuditScheduler.ts`)
 * usan `engine.admin` para sus propias decisiones internas.
 */
import type { OutboundTask, OutboundTaskSyncPort, OutboundTaskSyncResult, OutboundTaskType } from "./port.ts";

/** Forma mínima de `SqlClient`/`DbClient` que este gateway necesita -- declarada aquí
 *  (no importada) para no atar este paquete a un motor de base de datos concreto, mismo
 *  criterio que `packages/agent-core/src/sql.ts`. */
export interface OutboundSqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface OutboundConfigRow {
  webhook_url: string;
  webhook_secret: string;
  task_types: OutboundTaskType[];
}

export class OutboundTaskSyncGateway {
  private readonly db: OutboundSqlClient;
  private readonly port: OutboundTaskSyncPort;

  constructor(db: OutboundSqlClient, port: OutboundTaskSyncPort) {
    this.db = db;
    this.port = port;
  }

  /** `null` si el hotel no tiene conector configurado/habilitado para este tipo de
   *  tarea (el caso común -- un hotel independiente, o uno de cadena que aún no conectó
   *  su sistema, o que lo conectó solo para otro tipo de tarea). Nunca lanza: un error
   *  real de `pushTask()` (red, HTTP no-2xx, timeout) se captura aquí y se refleja como
   *  `delivered:false` en vez de propagarse -- ver docs/integraciones/
   *  conector-pms-enterprise.md ("best-effort a propósito"). */
  async syncTask(task: OutboundTask): Promise<OutboundTaskSyncResult | null> {
    const { rows } = await this.db.query<OutboundConfigRow>(
      `select webhook_url, webhook_secret, task_types from public.hotel_pms_outbound_config
       where hotel_id = $1 and enabled = true;`,
      [task.hotelId],
    );
    const config = rows[0];
    if (!config || !config.task_types.includes(task.taskType)) return null;

    try {
      return await this.port.pushTask({ url: config.webhook_url, secret: config.webhook_secret }, task);
    } catch (err) {
      return {
        delivered: false,
        skipped: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
