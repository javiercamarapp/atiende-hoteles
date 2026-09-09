// H8 · ADR-008: métricas en formato de exposición de Prometheus, sin dependencias
// nuevas (registro hecho a mano — suficiente para los pocos tipos de métrica que pide
// el encargo, evita ampliar la superficie de auditoría de `npm audit` con un cliente
// completo tipo `prom-client`).
//
// Qué se mide (REQ-OBS-*, ADR-008 "Métricas mínimas"):
//  - `http_request_duration_ms` (histograma): latencia por ruta+método+status.
//  - `http_requests_total` / `http_errors_total`: conteo de requests y de errores 5xx
//    por ruta+método.
//  - `reservations_created_total`: contador de reservas creadas con éxito.
//  - `outbox_pending` / `outbox_dead_letter` (gauges, consultados en vivo a la BD).
//  - `approvals_pending` (gauge): 0 si la tabla de aprobaciones (H6b) todavía no existe
//    en este esquema -- se detecta en runtime, nunca se inventa un número.
import type { DbClient } from "@atiende-hoteles/db";

const HISTOGRAM_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistogramState {
  buckets: number[]; // conteo acumulado por buckets (mismo orden que HISTOGRAM_BUCKETS_MS) + 1 para +Inf
  sum: number;
  count: number;
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class MetricsRegistry {
  private histograms = new Map<string, HistogramState>();
  private counters = new Map<string, number>();
  // H7 · REQ-AGT-020: costo estimado USD acumulado por (hotel, agente) desde que el
  // proceso arrancó -- espejo en memoria de lo que ya vive de forma durable en
  // `agent_run`/`agent_cost_mes()` (packages/db/migrations/0024), para que un panel de
  // Prometheus/Grafana externo pueda alertar sin tener que consultar la BD.
  private agentCostUsd = new Map<string, number>();
  // auditoria-2/legal [CRITICO]: observabilidad real de que la purga de la bóveda de
  // identidad y de conversaciones CORRE (no solo que la función existe) -- espejo en
  // memoria de lo que jobs/purgeIdentityVaultScheduler.ts / purgeConversationsScheduler.ts
  // ya escriben en audit_log, por hotel.
  private identityVaultPurgedTotal = new Map<string, number>();
  private conversationsPurgedTotal = new Map<string, number>();
  // REQ-SEG-011: mismo criterio -- espejo en memoria de lo que
  // jobs/purgePaymentPreauthScheduler.ts ya escribe en audit_log, por hotel, cada vez
  // que expira/purga tokens de pre-autorización vencidos.
  private paymentPreauthPurgedTotal = new Map<string, number>();

  private getHistogram(key: string): HistogramState {
    let h = this.histograms.get(key);
    if (!h) {
      h = { buckets: new Array(HISTOGRAM_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, h);
    }
    return h;
  }

  /** Registra una observación de latencia (ms) para una ruta+método+status(+hotel).
   *  Etiqueta `route` debe ser el PATRÓN de ruta (ej. `/hoteles/:hotelId/reservas`),
   *  nunca el path crudo con IDs -- evita explosión de cardinalidad en el registro.
   *
   *  auditoria-2/operabilidad [MEDIO]: `hotelId` es opcional (rutas sin sesión de
   *  hotel -- `/health`, `/login` -- no tienen uno) y, cuando se pasa, se agrega como
   *  etiqueta `hotel` -- sin esto, un panel de Prometheus/Grafana no podía alertar "el
   *  hotel X dejó de recibir tráfico" ni "la tasa de error 5xx del hotel Y se disparó"
   *  sin cruzar contra los logs estructurados (que sí llevan `hotel_id`), perdiendo la
   *  granularidad por hotel que un despliegue multi-hotel necesita para no tratar un
   *  problema de UN hotel como ruido agregado del sistema entero. El número de hoteles
   *  por despliegue es acotado (no es un ID de usuario/request), así que el costo de
   *  cardinalidad es aceptable -- mismo criterio ya usado por `incrementAgentCost`. */
  recordRequest(route: string, method: string, status: number, durationMs: number, hotelId?: string): void {
    const labels: Record<string, string> = { route, method, status: String(status) };
    if (hotelId) labels.hotel = hotelId;
    const key = labelKey(labels);
    const h = this.getHistogram(key);
    h.sum += durationMs;
    h.count += 1;
    let placed = false;
    for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
      if (durationMs <= HISTOGRAM_BUCKETS_MS[i]!) {
        h.buckets[i]! += 1;
        placed = true;
        break;
      }
    }
    if (!placed) h.buckets[HISTOGRAM_BUCKETS_MS.length]! += 1; // +Inf

    const totalKey = labelKey(labels);
    this.counters.set(`http_requests_total|${totalKey}`, (this.counters.get(`http_requests_total|${totalKey}`) ?? 0) + 1);
    if (status >= 500) {
      const errLabels: Record<string, string> = { route, method };
      if (hotelId) errLabels.hotel = hotelId;
      const errKey = labelKey(errLabels);
      this.counters.set(`http_errors_total|${errKey}`, (this.counters.get(`http_errors_total|${errKey}`) ?? 0) + 1);
    }
  }

  /** auditoria-2/operabilidad [MEDIO]: antes un contador GLOBAL sin ninguna etiqueta --
   *  no había forma de saber, desde `/metrics`, cuántas reservas se crearon en un hotel
   *  frente a otro. `hotelId` opcional para no romper ningún llamador existente. */
  incrementReservationsCreated(hotelId?: string): void {
    const key = hotelId ? `reservations_created_total|${labelKey({ hotel: hotelId })}` : "reservations_created_total";
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** REQ-AGT-020: acumula el costo USD estimado de una corrida de agente, etiquetado
   *  por hotel y por agente -- llamado una vez por corrida desde routes/agentes.ts
   *  después de insertar el `agent_run` correspondiente (misma cifra, dos superficies:
   *  BD para reporte/presupuesto, Prometheus para alertar en vivo). */
  incrementAgentCost(hotelId: string, agentName: string, costUsd: number): void {
    const key = labelKey({ hotel: hotelId, agente: agentName });
    this.agentCostUsd.set(key, (this.agentCostUsd.get(key) ?? 0) + costUsd);
  }

  /** auditoria-2/legal [CRITICO]: incrementa el contador de filas de `identity_vault`
   *  purgadas por hotel -- llamado desde jobs/purgeIdentityVaultScheduler.ts en cada
   *  tick que sí purgó algo (ver server.ts). */
  incrementIdentityVaultPurged(hotelId: string, count: number): void {
    if (count <= 0) return;
    const key = labelKey({ hotel: hotelId });
    this.identityVaultPurgedTotal.set(key, (this.identityVaultPurgedTotal.get(key) ?? 0) + count);
  }

  /** auditoria-2/legal [ALTO]: incrementa el contador de `conversation` purgadas por
   *  hotel (retención configurable, jobs/purgeConversations.ts). */
  incrementConversationsPurged(hotelId: string, count: number): void {
    if (count <= 0) return;
    const key = labelKey({ hotel: hotelId });
    this.conversationsPurgedTotal.set(key, (this.conversationsPurgedTotal.get(key) ?? 0) + count);
  }

  /** REQ-SEG-011: incrementa el contador de pre-autorizaciones de pago expiradas y
   *  purgadas (token_ref limpiado) por hotel -- llamado desde
   *  jobs/purgePaymentPreauthScheduler.ts en cada tick que sí purgó algo (ver
   *  server.ts). */
  incrementPaymentPreauthPurged(hotelId: string, count: number): void {
    if (count <= 0) return;
    const key = labelKey({ hotel: hotelId });
    this.paymentPreauthPurgedTotal.set(key, (this.paymentPreauthPurgedTotal.get(key) ?? 0) + count);
  }

  /** Solo para pruebas: limpia todo el estado acumulado. */
  reset(): void {
    this.histograms.clear();
    this.counters.clear();
    this.agentCostUsd.clear();
    this.identityVaultPurgedTotal.clear();
    this.conversationsPurgedTotal.clear();
    this.paymentPreauthPurgedTotal.clear();
  }

  private renderHistograms(): string {
    if (this.histograms.size === 0) return "";
    const lines: string[] = [
      "# HELP http_request_duration_ms Duración de la solicitud HTTP en milisegundos, por ruta/método/status.",
      "# TYPE http_request_duration_ms histogram",
    ];
    for (const [key, h] of this.histograms) {
      let cumulative = 0;
      for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
        cumulative += h.buckets[i]!;
        lines.push(`http_request_duration_ms_bucket{${key},le="${HISTOGRAM_BUCKETS_MS[i]}"} ${cumulative}`);
      }
      cumulative += h.buckets[HISTOGRAM_BUCKETS_MS.length]!;
      lines.push(`http_request_duration_ms_bucket{${key},le="+Inf"} ${cumulative}`);
      lines.push(`http_request_duration_ms_sum{${key}} ${h.sum}`);
      lines.push(`http_request_duration_ms_count{${key}} ${h.count}`);
    }
    return lines.join("\n") + "\n";
  }

  private renderCounters(): string {
    const requestsLines: string[] = [];
    const errorsLines: string[] = [];
    const reservationsLines: string[] = [];
    for (const [key, value] of this.counters) {
      if (key.startsWith("http_requests_total|")) {
        requestsLines.push(`http_requests_total{${key.slice("http_requests_total|".length)}} ${value}`);
      } else if (key.startsWith("http_errors_total|")) {
        errorsLines.push(`http_errors_total{${key.slice("http_errors_total|".length)}} ${value}`);
      } else if (key === "reservations_created_total") {
        reservationsLines.push(`reservations_created_total ${value}`);
      } else if (key.startsWith("reservations_created_total|")) {
        reservationsLines.push(`reservations_created_total{${key.slice("reservations_created_total|".length)}} ${value}`);
      }
    }
    const out: string[] = [];
    if (requestsLines.length) {
      out.push("# HELP http_requests_total Total de solicitudes HTTP procesadas, por ruta/método/status/hotel.");
      out.push("# TYPE http_requests_total counter");
      out.push(...requestsLines);
    }
    out.push("# HELP http_errors_total Total de respuestas 5xx (error del servidor), por ruta/método/hotel.");
    out.push("# TYPE http_errors_total counter");
    out.push(...errorsLines);
    out.push("# HELP reservations_created_total Total de reservas creadas con éxito desde que el proceso arrancó, por hotel cuando se conoce.");
    out.push("# TYPE reservations_created_total counter");
    // auditoria-2/operabilidad [MEDIO]: antes era un único contador global sin
    // etiquetas; ahora puede tener 0+ líneas etiquetadas por hotel -- si nunca se creó
    // ninguna reserva todavía, se sigue reportando el total en 0 (nunca se omite la
    // métrica, REQ-UX-002 aplicado también a observabilidad).
    out.push(...(reservationsLines.length ? reservationsLines : ["reservations_created_total 0"]));
    return out.join("\n") + (out.length ? "\n" : "");
  }

  private renderAgentCost(): string {
    if (this.agentCostUsd.size === 0) return "";
    const lines = [
      "# HELP agent_cost_usd_total Costo estimado en USD acumulado por corrida de agente, por hotel y agente.",
      "# TYPE agent_cost_usd_total counter",
    ];
    for (const [key, value] of this.agentCostUsd) {
      lines.push(`agent_cost_usd_total{${key}} ${value}`);
    }
    return lines.join("\n") + "\n";
  }

  /** Combina las métricas en memoria (latencia/errores/reservas) con los gauges que
   *  requieren una consulta en vivo a la BD (outbox pendiente/dead-letter, aprobaciones
   *  pendientes). Nunca lanza: si una consulta falla, reporta el gauge como
   *  indisponible en un comentario en vez de tumbar todo `/metrics`.
   *
   *  auditoria-2/operabilidad [ALTO]: `dbPoolErrorCount` (de
   *  `EmbeddedPostgresEngine.getPoolErrorCount()`, packages/db) expone cuántos eventos
   *  `pool.on("error")` ha visto el proceso -- antes esos eventos se descartaban sin
   *  dejar NINGÚN rastro observable; ahora también quedan en `/metrics` como gauge,
   *  además de la línea de log estructurada que emite `packages/db` en el momento. */
  private renderIdentityVaultPurge(): string {
    if (this.identityVaultPurgedTotal.size === 0) return "";
    const lines = [
      "# HELP identity_vault_purged_total Filas de identity_vault purgadas por retención vencida, por hotel, desde que el proceso arrancó.",
      "# TYPE identity_vault_purged_total counter",
    ];
    for (const [key, value] of this.identityVaultPurgedTotal) {
      lines.push(`identity_vault_purged_total{${key}} ${value}`);
    }
    return lines.join("\n") + "\n";
  }

  private renderConversationsPurge(): string {
    if (this.conversationsPurgedTotal.size === 0) return "";
    const lines = [
      "# HELP conversations_purged_total Conversaciones purgadas por retención vencida, por hotel, desde que el proceso arrancó.",
      "# TYPE conversations_purged_total counter",
    ];
    for (const [key, value] of this.conversationsPurgedTotal) {
      lines.push(`conversations_purged_total{${key}} ${value}`);
    }
    return lines.join("\n") + "\n";
  }

  /** REQ-SEG-011: observabilidad real de que la purga de tokens de pre-autorización
   *  vencidos CORRE (no solo que la función existe), mismo criterio que
   *  `renderIdentityVaultPurge`/`renderConversationsPurge`. */
  private renderPaymentPreauthPurge(): string {
    if (this.paymentPreauthPurgedTotal.size === 0) return "";
    const lines = [
      "# HELP payment_preauth_purged_total Pre-autorizaciones de pago expiradas y con token_ref purgado, por hotel, desde que el proceso arrancó.",
      "# TYPE payment_preauth_purged_total counter",
    ];
    for (const [key, value] of this.paymentPreauthPurgedTotal) {
      lines.push(`payment_preauth_purged_total{${key}} ${value}`);
    }
    return lines.join("\n") + "\n";
  }

  async render(admin: DbClient, dbPoolErrorCount?: number): Promise<string> {
    const parts: string[] = [
      this.renderHistograms(),
      this.renderCounters(),
      this.renderAgentCost(),
      this.renderIdentityVaultPurge(),
      this.renderConversationsPurge(),
      this.renderPaymentPreauthPurge(),
    ];

    parts.push(await this.renderOutboxGauges(admin));
    parts.push(await this.renderApprovalsGauge(admin));
    if (dbPoolErrorCount != null) {
      parts.push(
        [
          "# HELP db_pool_errors_total Eventos pool.on(\"error\") del pool de Postgres desde que el proceso arrancó.",
          "# TYPE db_pool_errors_total counter",
          `db_pool_errors_total ${dbPoolErrorCount}`,
        ].join("\n"),
      );
    }

    return parts.filter(Boolean).join("\n");
  }

  private async renderOutboxGauges(admin: DbClient): Promise<string> {
    try {
      const { rows } = await admin.query<{ status: string; count: string }>(
        "select status, count(*)::text as count from public.outbox group by status;",
      );
      const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
      const pending = byStatus.get("pendiente") ?? 0;
      const deadLetter = byStatus.get("fallido") ?? 0;
      return [
        "# HELP outbox_pending Eventos del outbox en estado pendiente (aún no entregados).",
        "# TYPE outbox_pending gauge",
        `outbox_pending ${pending}`,
        "# HELP outbox_dead_letter Eventos del outbox agotaron sus reintentos (dead-letter).",
        "# TYPE outbox_dead_letter gauge",
        `outbox_dead_letter ${deadLetter}`,
      ].join("\n");
    } catch {
      // Tabla outbox no disponible todavía (ej. BD sin migrar en un entorno de prueba
      // mínimo) -- se documenta como no disponible en vez de fallar /metrics entero.
      return "# outbox_pending/outbox_dead_letter no disponibles (tabla public.outbox inaccesible)";
    }
  }

  private async renderApprovalsGauge(admin: DbClient): Promise<string> {
    try {
      const { rows: exists } = await admin.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'approval'
         ) as exists;`,
      );
      if (!exists[0]?.exists) {
        return [
          "# HELP approvals_pending Aprobaciones humanas pendientes (needs_approval).",
          "# TYPE approvals_pending gauge",
          "# approvals_pending no disponible todavía: la tabla public.approval no existe en este esquema (H6b).",
        ].join("\n");
      }
      const { rows } = await admin.query<{ count: string }>(
        "select count(*)::text as count from public.approval where status = 'pendiente';",
      );
      return [
        "# HELP approvals_pending Aprobaciones humanas pendientes (needs_approval).",
        "# TYPE approvals_pending gauge",
        `approvals_pending ${Number(rows[0]?.count ?? "0")}`,
      ].join("\n");
    } catch {
      return "# approvals_pending no disponible (error consultando public.approval)";
    }
  }
}
