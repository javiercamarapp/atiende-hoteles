// H6b · Implementacion de `ApprovalQueue` (contrato definido en approval.ts, H6a)
// respaldada por `agent_approval`/`agent_approval_confirmation`
// (packages/db/migrations/0042_agent_approval.sql), tal como el README de H6a la dejo
// pendiente: "el contrato esta listo para una implementacion respaldada por Postgres,
// pero esa implementacion es trabajo de un hito posterior". NINGUN cambio a
// `AgentRunner`/`tool.ts`/al contrato `ApprovalQueue` fue necesario -- exactamente la
// promesa que hacia ese comentario.
//
// Debe pasar la MISMA bateria de pruebas de contrato que `InMemoryApprovalQueue`
// (ver tests/support/approvalQueueContract.ts) mas la propiedad que la version en
// memoria estructuralmente NO puede tener: sobrevive un reinicio del PROCESO porque el
// estado vive en Postgres, no en un Map de este objeto.

import { ApprovalError } from "./errors.ts";
import { hashApprovalInput } from "./approval.ts";
import type {
  ApprovalConfirmation,
  ApprovalDecision,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalStatus,
  DecideApprovalParams,
  RequestApprovalParams,
} from "./approval.ts";
import type { SqlClient } from "./sql.ts";

interface ApprovalRow {
  id: string;
  org_id: string;
  hotel_id: string;
  tool_name: string;
  input_hash: string;
  input_summary: string;
  texto_mostrado: string;
  requested_by: string;
  is_money: boolean;
  required_confirmations: number;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
}

interface ConfirmationRow {
  actor: string;
  role: string | null;
  decision: ApprovalDecision;
  texto_exacto: string;
  decided_at: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface PostgresApprovalQueueOptions {
  /** Default 15 minutos, igual que InMemoryApprovalQueue. */
  readonly defaultTtlMs?: number;
  /** Default 2 (GOB-026), igual que InMemoryApprovalQueue. */
  readonly moneyRequiredConfirmations?: number;
  readonly now?: () => Date;
}

export class PostgresApprovalQueue implements ApprovalQueue {
  // Campos explicitos, no "parameter properties" (`constructor(private readonly db:
  // ...)`): ese azucar de TypeScript no esta soportado por el modo "strip types" de Node
  // (`node --experimental-strip-types`), el runtime real de apps/api (ver
  // apps/api/package.json "dev"/"start") -- con el azucar, cargar este modulo en tiempo
  // de ejecucion tumbaba el proceso completo con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
  private readonly db: SqlClient;
  private readonly defaultTtlMs: number;
  private readonly moneyRequiredConfirmations: number;
  private readonly now: () => Date;

  constructor(db: SqlClient, options: PostgresApprovalQueueOptions = {}) {
    this.db = db;
    this.defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1000;
    this.moneyRequiredConfirmations = options.moneyRequiredConfirmations ?? 2;
    this.now = options.now ?? ((): Date => new Date());
  }

  async request(params: RequestApprovalParams): Promise<ApprovalRequest> {
    const inputHash = hashApprovalInput(params.input);
    const now = this.now();

    // Advisory lock (0042_agent_approval.sql): best-effort -- serializa esta llamada
    // contra otra EN LA MISMA transaccion ambiente (p.ej. la transaccion por-request que
    // abre apps/api/src/middleware.ts `dbSession`). Si el `db` recibido no esta dentro de
    // una transaccion explicita (p.ej. `engine.admin` fuera de BEGIN/COMMIT), el lock se
    // libera al terminar esta sentencia y dos llamadas realmente concurrentes podrian
    // colarse -- documentado aqui en vez de fingir una garantia que no se puede dar sin
    // control explicito de transaccion (el contrato de `ApprovalQueue.request()` no
    // expone ese control).
    await this.db.query("select public.lock_agent_approval_key($1, $2, $3, $4);", [
      params.hotelId,
      params.toolName,
      inputHash,
      params.requestedBy,
    ]);

    const { rows: existingRows } = await this.db.query<ApprovalRow>(
      `select * from public.agent_approval
       where hotel_id = $1 and tool_name = $2 and input_hash = $3 and requested_by = $4
         and expires_at > $5
       order by requested_at desc
       limit 1;`,
      [params.hotelId, params.toolName, inputHash, params.requestedBy, toIso(now)],
    );
    if (existingRows[0]) {
      return this.hydrate(existingRows[0]);
    }

    const requiredConfirmations = params.isMoney ? this.moneyRequiredConfirmations : 1;
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? this.defaultTtlMs));
    const { rows } = await this.db.query<ApprovalRow>(
      `insert into public.agent_approval
         (org_id, hotel_id, tool_name, input_hash, input_summary, texto_mostrado, requested_by,
          is_money, required_confirmations, status, requested_at, expires_at, input_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente', $10, $11, $12::jsonb)
       returning *;`,
      [
        params.orgId,
        params.hotelId,
        params.toolName,
        inputHash,
        params.inputSummary ?? params.textoMostrado,
        params.textoMostrado,
        params.requestedBy,
        params.isMoney,
        requiredConfirmations,
        toIso(now),
        expiresAt.toISOString(),
        JSON.stringify(params.input ?? null),
      ],
    );
    return this.hydrate(rows[0]!);
  }

  /**
   * Extension MAS ALLA del contrato `ApprovalQueue` (ver 0045_agent_approval_input_json.sql):
   * el input REAL ya validado que recibio la tool, para que `apps/api` pueda ejecutar la
   * tool correspondiente DESPUES de que la doble confirmacion se completo fuera de una
   * corrida de `AgentRunner` (dos peticiones HTTP separadas de dos aprobadores distintos).
   * Devuelve `undefined` si la solicitud no existe.
   */
  async getStoredInput(id: string): Promise<unknown> {
    const { rows } = await this.db.query<{ input_json: unknown }>(
      "select input_json from public.agent_approval where id = $1;",
      [id],
    );
    return rows[0]?.input_json;
  }

  async decide(params: DecideApprovalParams): Promise<ApprovalRequest> {
    const now = params.now ?? this.now();
    const row = await this.fetchRowOrThrow(params.approvalId);

    let status = row.status;
    if (status === "pendiente" && this.isExpired(row, now)) {
      status = "expirada";
      await this.db.query("update public.agent_approval set status = 'expirada', updated_at = now() where id = $1;", [
        row.id,
      ]);
    }
    if (status !== "pendiente") {
      throw new ApprovalError(
        `solicitud de aprobacion "${params.approvalId}" ya no esta pendiente (estado actual: ${status})`,
      );
    }

    const confirmations = await this.loadConfirmations(row.id);

    if (params.decision === "rechazar") {
      await this.db.query("update public.agent_approval set status = 'rechazada', updated_at = now() where id = $1;", [
        row.id,
      ]);
      await this.insertConfirmation(row.id, params, now);
      return this.hydrate(await this.fetchRowOrThrow(row.id));
    }

    // aud-1 agentico.md MEDIO #6: GOB-026 exige DOS ROLES distintos, no solo dos actores.
    if (row.is_money && !params.role) {
      throw new ApprovalError(
        `aprobar la solicitud de dinero "${params.approvalId}" requiere declarar el rol del ` +
          `aprobador (GOB-026: se exigen dos ROLES distintos, no solo dos actores)`,
      );
    }

    const yaConfirmoEsteActor = confirmations.some((c) => c.actor === params.actor && c.decision === "aprobar");
    const yaConfirmoEsteRol =
      row.is_money && params.role !== undefined && confirmations.some((c) => c.decision === "aprobar" && c.role === params.role);
    if (yaConfirmoEsteActor || yaConfirmoEsteRol) {
      throw new ApprovalError(
        `el actor "${params.actor}"${params.role ? ` (rol "${params.role}")` : ""} ya confirmo esta ` +
          `aprobacion; se requiere un segundo actor con un ROL distinto para la doble confirmacion de ` +
          `dinero (GOB-026)`,
      );
    }

    await this.insertConfirmation(row.id, params, now);
    const aprobaciones = confirmations.filter((c) => c.decision === "aprobar").length + 1;
    if (aprobaciones >= row.required_confirmations) {
      await this.db.query("update public.agent_approval set status = 'aprobada', updated_at = now() where id = $1;", [
        row.id,
      ]);
    }
    return this.hydrate(await this.fetchRowOrThrow(row.id));
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const { rows } = await this.db.query<ApprovalRow>("select * from public.agent_approval where id = $1;", [id]);
    if (!rows[0]) return undefined;
    return this.hydrate(rows[0]);
  }

  async expirePending(now: Date = this.now()): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `update public.agent_approval
       set status = 'expirada', updated_at = now()
       where status = 'pendiente' and expires_at <= $1
       returning id;`,
      [toIso(now)],
    );
    return rows.length;
  }

  private isExpired(row: ApprovalRow, now: Date): boolean {
    return new Date(row.expires_at).getTime() <= now.getTime();
  }

  private async fetchRowOrThrow(id: string): Promise<ApprovalRow> {
    const { rows } = await this.db.query<ApprovalRow>("select * from public.agent_approval where id = $1;", [id]);
    if (!rows[0]) {
      throw new ApprovalError(`solicitud de aprobacion inexistente: ${id}`);
    }
    return rows[0];
  }

  private async loadConfirmations(approvalId: string): Promise<ApprovalConfirmation[]> {
    const { rows } = await this.db.query<ConfirmationRow>(
      `select actor, role, decision, texto_exacto, decided_at
       from public.agent_approval_confirmation
       where approval_id = $1
       order by decided_at asc;`,
      [approvalId],
    );
    return rows.map((r) => ({
      actor: r.actor,
      role: r.role ?? undefined,
      decision: r.decision,
      textoExacto: r.texto_exacto,
      decidedAt: toIso(r.decided_at),
    }));
  }

  private async insertConfirmation(approvalId: string, params: DecideApprovalParams, now: Date): Promise<void> {
    await this.db.query(
      `insert into public.agent_approval_confirmation (approval_id, actor, role, decision, texto_exacto, decided_at)
       values ($1, $2, $3, $4, $5, $6);`,
      [approvalId, params.actor, params.role ?? null, params.decision, params.textoExacto, toIso(now)],
    );
  }

  private async hydrate(row: ApprovalRow): Promise<ApprovalRequest> {
    const confirmations = await this.loadConfirmations(row.id);
    return {
      id: row.id,
      toolName: row.tool_name,
      inputHash: row.input_hash,
      orgId: row.org_id,
      hotelId: row.hotel_id,
      requestedBy: row.requested_by,
      requestedAt: toIso(row.requested_at),
      expiresAt: toIso(row.expires_at),
      isMoney: row.is_money,
      requiredConfirmations: row.required_confirmations,
      textoMostrado: row.texto_mostrado,
      inputSummary: row.input_summary,
      status: row.status,
      confirmations,
    };
  }
}
