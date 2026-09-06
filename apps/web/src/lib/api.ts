/**
 * Cliente de API tipado — apunta a `VITE_API_URL` (ADR-004, backend Hono
 * construido en H2 por otro agente en paralelo). Sin backend disponible
 * (variable sin configurar, red caída, 5xx), cada función lanza
 * `ApiUnavailableError`, que las pantallas capturan para mostrar
 * `EstadoError` honesto — nunca datos de ejemplo (REQ-UX-002).
 */

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

const SESSION_KEY = "atiende_hoteles_session";

export interface Sesion {
  token: string;
  email: string;
  rol: string;
}

export function leerSesion(): Sesion | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Sesion;
  } catch {
    return null;
  }
}

export function guardarSesion(sesion: Sesion) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(sesion));
}

export function borrarSesion() {
  window.localStorage.removeItem(SESSION_KEY);
}

export class ApiUnavailableError extends Error {
  /** Nombre de la integración/servicio que falló, para nombrarlo en EstadoError. */
  integracion: string;
  /** true cuando la causa es la ausencia de configuración/credenciales, no un error transitorio. */
  pendienteCredenciales: boolean;

  constructor(message: string, opts?: { integracion?: string; pendienteCredenciales?: boolean }) {
    super(message);
    this.name = "ApiUnavailableError";
    this.integracion = opts?.integracion ?? "API de Atiende Hoteles";
    this.pendienteCredenciales = opts?.pendienteCredenciales ?? false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiUnavailableError(
      "VITE_API_URL no está configurada en este entorno: el panel no tiene a dónde conectarse todavía.",
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

  if (!res.ok) {
    const cuerpo = await res.json().catch(() => null);
    throw new ApiUnavailableError((cuerpo as { message?: string } | null)?.message ?? `La API respondió con el estado ${res.status}.`, {
      integracion: "API de Atiende Hoteles",
    });
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- Dominio: tipos mínimos (contrato con ADR-004, sin datos hasta que exista backend real) ----

export interface Hotel {
  id: string;
  nombre: string;
}

export interface ResumenKpis {
  ocupacionPct: number | null;
  adr: number | null;
  revpar: number | null;
  reservasHoy: number | null;
}

export interface Reserva {
  id: string;
  huesped: string;
  llegada: string;
  salida: string;
  habitacion: string;
  canal: string;
  estado: string;
  total: number;
}

export interface Huesped {
  id: string;
  nombre: string;
  email: string | null;
  estancias: number;
}

export interface TicketOperativo {
  id: string;
  titulo: string;
  area: "housekeeping" | "mantenimiento";
  prioridad: "baja" | "media" | "alta";
  estado: string;
}

export interface DisponibilidadFila {
  tipoHabitacion: string;
  disponibles: number;
  total: number;
  tarifaDesde: number;
}

export interface RecepcionMovimiento {
  id: string;
  huesped: string;
  habitacion: string;
  tipo: "check-in" | "check-out";
  hora: string;
  estado: string;
}

export interface PedidoAB {
  id: string;
  habitacionOMesa: string;
  items: string;
  estado: string;
  total: number;
}

export interface ConversacionMensaje {
  id: string;
  huesped: string;
  canal: "whatsapp" | "voz";
  ultimoMensaje: string;
  hace: string;
  requiereAprobacion: boolean;
}

export interface ResenaReputacion {
  id: string;
  fuente: "Google" | "Booking" | "TripAdvisor";
  calificacion: number;
  huesped: string;
  respondida: boolean;
}

export interface LineaCobro {
  id: string;
  concepto: string;
  monto: number;
  roiEventUrl: string | null;
}

export interface StaffCuenta {
  id: string;
  email: string;
  rol: string;
}

// ---- Auth ----

export async function login(email: string, password: string): Promise<Sesion> {
  return request<Sesion>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

// ---- Hoteles (selector multi-hotel) ----

export async function listarHoteles(): Promise<Hotel[]> {
  return request<Hotel[]>("/hoteles");
}

// ---- Módulos ----

export async function obtenerResumen(hotelId: string): Promise<ResumenKpis> {
  return request<ResumenKpis>(`/hoteles/${hotelId}/resumen`);
}

export async function listarReservas(hotelId: string): Promise<Reserva[]> {
  return request<Reserva[]>(`/hoteles/${hotelId}/reservas`);
}

export async function listarHuespedes(hotelId: string): Promise<Huesped[]> {
  return request<Huesped[]>(`/hoteles/${hotelId}/huespedes`);
}

export async function listarTickets(hotelId: string, area: "housekeeping" | "mantenimiento"): Promise<TicketOperativo[]> {
  return request<TicketOperativo[]>(`/hoteles/${hotelId}/tickets?area=${area}`);
}

export async function obtenerModulo<T>(hotelId: string, modulo: string): Promise<T> {
  return request<T>(`/hoteles/${hotelId}/${modulo}`);
}

export async function listarDisponibilidad(hotelId: string): Promise<DisponibilidadFila[]> {
  return obtenerModulo<DisponibilidadFila[]>(hotelId, "disponibilidad");
}

export async function listarMovimientosRecepcion(hotelId: string): Promise<RecepcionMovimiento[]> {
  return obtenerModulo<RecepcionMovimiento[]>(hotelId, "recepcion");
}

export async function listarPedidosAB(hotelId: string): Promise<PedidoAB[]> {
  return obtenerModulo<PedidoAB[]>(hotelId, "alimentos-bebidas");
}

export async function listarConversaciones(hotelId: string): Promise<ConversacionMensaje[]> {
  return obtenerModulo<ConversacionMensaje[]>(hotelId, "mensajeria");
}

export async function listarResenas(hotelId: string): Promise<ResenaReputacion[]> {
  return obtenerModulo<ResenaReputacion[]>(hotelId, "reputacion");
}

export async function listarCobrosVariables(hotelId: string): Promise<LineaCobro[]> {
  return obtenerModulo<LineaCobro[]>(hotelId, "back-office/cobros");
}

export async function listarStaff(hotelId: string): Promise<StaffCuenta[]> {
  return obtenerModulo<StaffCuenta[]>(hotelId, "configuracion/staff");
}
