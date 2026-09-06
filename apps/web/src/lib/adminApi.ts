/**
 * H12b · LAUNCH-007: cliente de API de la consola superadmin (`/admin/*`). Archivo
 * DELIBERADAMENTE separado de `./api.ts` (propiedad de otro lote en paralelo, ver
 * despacho de esta tarea) — reimplementa el mismo patrón `request()`/`ApiUnavailableError`
 * en vez de editar ese archivo compartido. Reutiliza SOLO lectura de `api.ts`
 * (`API_BASE_URL`, `leerSesion`, `borrarSesion`, `ApiUnavailableError`) para que la sesión
 * sea una única fuente de verdad en todo el panel.
 */
import { API_BASE_URL, ApiUnavailableError, borrarSesion, leerSesion } from "./api";

export { ApiUnavailableError } from "./api";

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiUnavailableError(
      "VITE_API_URL no está configurada en este entorno: la consola no tiene a dónde conectarse todavía.",
      { integracion: "API de Atiende Hoteles", pendienteCredenciales: true },
    );
  }

  const sesion = leerSesion();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(sesion ? { Authorization: `Bearer ${sesion.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiUnavailableError(`No se pudo conectar con la API en ${API_BASE_URL}. Verifica que el backend esté disponible.`, {
      integracion: "API de Atiende Hoteles",
    });
  }

  if (res.status === 401) {
    borrarSesion();
    throw new ApiUnavailableError("La sesión expiró o no es válida. Vuelve a iniciar sesión.", {
      integracion: "API de Atiende Hoteles",
    });
  }

  // 403 se deja pasar como ApiUnavailableError con un mensaje explícito distinto de 401:
  // la consola lo usa para mostrar "no eres superadmin de plataforma" en vez de forzar un
  // logout (a diferencia de 401, un 403 de /admin no invalida la sesión del panel normal).
  if (res.status === 403) {
    const cuerpo = await res.json().catch(() => null);
    throw new ApiUnavailableError(
      (cuerpo as { message?: string } | null)?.message ?? "No tienes permiso de superadmin de plataforma para ver la consola /admin.",
      { integracion: "Consola superadmin" },
    );
  }

  if (!res.ok) {
    const cuerpo = await res.json().catch(() => null);
    throw new ApiUnavailableError((cuerpo as { message?: string } | null)?.message ?? `La API respondió con el estado ${res.status}.`, {
      integracion: "API de Atiende Hoteles",
    });
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AdminHotelResumen {
  hotel_id: string;
  nombre: string;
  org_nombre: string;
  staff_count: number;
  ultima_actividad_at: string | null;
  reservas_total: number;
  reservas_confirmadas: number;
  ingresos_totales: number;
  costo_ia_mes_usd: number;
  techo_ia_mes_usd: number;
  outbox_pendientes: number;
  outbox_dead_letter: number;
  aprobaciones_vencidas: number;
}

export interface AdminMetricasGlobales {
  hotelesTotal: number;
  reservasTotal: number;
  reservasConfirmadasTotal: number;
  ocupacionMediaHabitaciones: number | null;
  ingresosTotales: number;
  costoIaMesUsdTotal: number;
  techoIaMesUsdTotal: number;
  outboxPendientesTotal: number;
  outboxDeadLetterTotal: number;
  aprobacionesVencidasTotal: number;
}

export interface AdminAgenteResumen {
  hotel_id: string;
  hotel_nombre: string;
  agent_name: string;
  gate: "shadow" | "propone" | "autopilot";
  monthly_ceiling_usd: number;
  costo_mes_usd: number;
}

export interface AdminNegocio {
  generadoEn: string;
  hoteles: AdminHotelResumen[];
  metricasGlobales: AdminMetricasGlobales;
  agentes: AdminAgenteResumen[];
}

export interface AdminAuditLogEntry {
  id: string;
  actor_id: string;
  action: string;
  detail: unknown;
  created_at: string;
}

export async function obtenerAdminNegocio(): Promise<AdminNegocio> {
  return adminRequest<AdminNegocio>("/admin/negocio");
}

export async function listarAdminAuditoria(): Promise<AdminAuditLogEntry[]> {
  return adminRequest<AdminAuditLogEntry[]>("/admin/auditoria");
}

export async function reintentarOutbox(outboxId: string): Promise<{ ok: boolean }> {
  return adminRequest(`/admin/outbox/${outboxId}/reintentar`, { method: "POST" });
}

export interface HealthStatus {
  status: string;
}

export interface ReadyStatus {
  status: string;
  migrationsApplied?: number;
  reason?: string;
}

/** `/health` y `/ready` son públicos (sin sesión, ADR-008) -- la consola los llama con
 *  `fetch` directo, sin pasar por `adminRequest` (no debe fallar por falta de token). */
export async function obtenerSaludApi(): Promise<{ health: HealthStatus | null; ready: ReadyStatus | null }> {
  if (!API_BASE_URL) return { health: null, ready: null };
  const [health, ready] = await Promise.allSettled([
    fetch(`${API_BASE_URL}/health`).then((r) => r.json() as Promise<HealthStatus>),
    fetch(`${API_BASE_URL}/ready`).then((r) => r.json() as Promise<ReadyStatus>),
  ]);
  return {
    health: health.status === "fulfilled" ? health.value : null,
    ready: ready.status === "fulfilled" ? ready.value : null,
  };
}
