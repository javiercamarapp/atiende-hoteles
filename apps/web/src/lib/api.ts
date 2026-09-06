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
  codigoConfirmacion?: string;
  folioId?: string | null;
}

export type EstadoReserva =
  | "cotizada"
  | "confirmada"
  | "check_in"
  | "en_estancia"
  | "check_out"
  | "cerrada"
  | "cancelada"
  | "no_show";

export interface Cotizacion {
  nights: number;
  currency: string;
  netAmount: number;
  ivaAmount: number;
  ishAmount: number;
  totalAmount: number;
  nightlyBreakdown: { date: string; price: number }[];
}

export interface CrearReservaInput {
  roomTypeId: string;
  guestId?: string | null;
  checkInDate: string;
  checkOutDate: string;
}

export interface ModificarReservaInput {
  roomTypeId?: string;
  checkInDate: string;
  checkOutDate: string;
}

export interface CancelacionResultado {
  id: string;
  estado: string;
  codigoConfirmacion: string;
  montoPenalizacion: number;
  montoReembolso: number;
}

export interface TarifaFila {
  id: string;
  roomTypeId: string;
  fecha: string;
  precio: number;
  moneda: string;
  estadiaMinima: number;
  cerradoLlegada: boolean;
  cerradoSalida: boolean;
}

export interface ActualizarTarifaInput {
  roomTypeId: string;
  date?: string;
  desde?: string;
  hasta?: string;
  price: number;
  minStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
}

export interface ConfigImpuestos {
  ivaRate: number;
  ishRate: number;
}

export interface PoliticaCancelacion {
  freeUntilHours: number;
  penaltyPct: number;
  noShowPct: number;
  depositPct: number;
}

export interface DisponibilidadGridDia {
  fecha: string;
  disponibles: number | null;
  total: number | null;
  tarifa: number | null;
  cerradoLlegada: boolean;
  cerradoSalida: boolean;
  estadiaMinima: number;
}

export interface DisponibilidadGridFila {
  tipoHabitacionId: string;
  tipoHabitacion: string;
  dias: DisponibilidadGridDia[];
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
  tipoHabitacionId: string;
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

// ---- Reservas: cotizar, crear, modificar, cancelar (H4) ----

function claveIdempotencia(): string {
  return crypto.randomUUID();
}

export async function cotizarReserva(
  hotelId: string,
  input: { roomTypeId: string; checkInDate: string; checkOutDate: string },
): Promise<Cotizacion> {
  return request<Cotizacion>(`/hoteles/${hotelId}/quotes`, { method: "POST", body: JSON.stringify(input) });
}

export async function obtenerReserva(hotelId: string, reservationId: string): Promise<Reserva> {
  return request<Reserva>(`/hoteles/${hotelId}/reservas/${reservationId}`);
}

export async function crearReserva(hotelId: string, input: CrearReservaInput): Promise<Reserva> {
  return request<Reserva>(`/hoteles/${hotelId}/reservas`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotencia() },
    body: JSON.stringify(input),
  });
}

export async function modificarReserva(
  hotelId: string,
  reservationId: string,
  input: ModificarReservaInput,
): Promise<Reserva> {
  return request<Reserva>(`/hoteles/${hotelId}/reservas/${reservationId}/fechas`, {
    method: "PATCH",
    headers: { "idempotency-key": claveIdempotencia() },
    body: JSON.stringify(input),
  });
}

export async function cancelarReserva(hotelId: string, reservationId: string): Promise<CancelacionResultado> {
  return request<CancelacionResultado>(`/hoteles/${hotelId}/reservas/${reservationId}/cancelar`, { method: "POST" });
}

export async function transicionarReserva(hotelId: string, reservationId: string, toStatus: string): Promise<Reserva> {
  return request<Reserva>(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
    method: "PATCH",
    body: JSON.stringify({ toStatus }),
  });
}

// ---- Disponibilidad por rango (grilla) ----

export async function listarDisponibilidadGrid(hotelId: string, desde: string, hasta: string): Promise<DisponibilidadGridFila[]> {
  return request<DisponibilidadGridFila[]>(`/hoteles/${hotelId}/disponibilidad/grid?desde=${desde}&hasta=${hasta}`);
}

// ---- Tarifas / impuestos / política de cancelación (H4) ----

export async function listarTarifas(
  hotelId: string,
  params: { desde: string; hasta: string; roomTypeId?: string },
): Promise<TarifaFila[]> {
  const qs = new URLSearchParams({ desde: params.desde, hasta: params.hasta });
  if (params.roomTypeId) qs.set("roomTypeId", params.roomTypeId);
  return request<TarifaFila[]>(`/hoteles/${hotelId}/tarifas?${qs.toString()}`);
}

export async function actualizarTarifa(hotelId: string, input: ActualizarTarifaInput): Promise<unknown> {
  return request(`/hoteles/${hotelId}/tarifas`, { method: "PUT", body: JSON.stringify(input) });
}

export async function obtenerImpuestos(hotelId: string): Promise<ConfigImpuestos> {
  return request<ConfigImpuestos>(`/hoteles/${hotelId}/impuestos`);
}

export async function actualizarImpuestos(hotelId: string, input: ConfigImpuestos): Promise<ConfigImpuestos> {
  return request<ConfigImpuestos>(`/hoteles/${hotelId}/impuestos`, { method: "PUT", body: JSON.stringify(input) });
}

export async function obtenerPoliticaCancelacion(hotelId: string): Promise<PoliticaCancelacion> {
  return request<PoliticaCancelacion>(`/hoteles/${hotelId}/politica-cancelacion`);
}

export async function actualizarPoliticaCancelacion(hotelId: string, input: PoliticaCancelacion): Promise<PoliticaCancelacion> {
  return request<PoliticaCancelacion>(`/hoteles/${hotelId}/politica-cancelacion`, { method: "PUT", body: JSON.stringify(input) });
}

// ---- H6b: housekeeping / mantenimiento / aprobaciones / mensajería ----

export interface TareaHousekeeping {
  id: string;
  estado: string;
  prioridad: string;
  asignadoA: string | null;
  asignadoEmail: string | null;
  slaVence: string | null;
}

export interface HabitacionTablero {
  roomId: string;
  roomCode: string;
  housekeepingStatus: "sucia" | "limpia" | "inspeccionada" | "fuera_de_servicio";
  tarea: TareaHousekeeping | null;
}

export async function obtenerTableroHousekeeping(hotelId: string): Promise<HabitacionTablero[]> {
  return request<HabitacionTablero[]>(`/hoteles/${hotelId}/housekeeping/tablero`);
}

export async function crearTareaHousekeeping(
  hotelId: string,
  input: { roomCode: string; priority: "alta" | "media" | "baja"; checklist?: string[]; notes?: string },
): Promise<{ taskId: string }> {
  return request(`/hoteles/${hotelId}/housekeeping/tareas`, { method: "POST", body: JSON.stringify(input) });
}

export async function iniciarTareaHousekeeping(hotelId: string, taskId: string): Promise<{ estado: string }> {
  return request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/iniciar`, { method: "POST" });
}

export async function terminarTareaHousekeeping(hotelId: string, taskId: string): Promise<{ estado: string }> {
  return request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/terminar`, { method: "POST" });
}

export async function inspeccionarTareaHousekeeping(
  hotelId: string,
  taskId: string,
  input: { resultado: "aprobada" | "rechazada"; nota?: string },
): Promise<{ housekeepingStatus: string }> {
  return request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/inspeccionar`, { method: "POST", body: JSON.stringify(input) });
}

export async function marcarFueraDeServicio(hotelId: string, roomId: string, fueraDeServicio: boolean): Promise<{ housekeepingStatus: string }> {
  return request(`/hoteles/${hotelId}/housekeeping/habitaciones/${roomId}/fuera-de-servicio`, {
    method: "POST",
    body: JSON.stringify({ fueraDeServicio }),
  });
}

export interface TicketMantenimiento {
  id: string;
  roomCode: string | null;
  titulo: string;
  descripcion: string;
  origen: string;
  severidad: "alta" | "media" | "baja";
  estado: string;
  asignadoA: string | null;
  costoEstimado: number;
  costoReal: number | null;
  aprobacionId: string | null;
  creadoEn: string;
}

export async function listarTicketsMantenimiento(hotelId: string): Promise<TicketMantenimiento[]> {
  return request<TicketMantenimiento[]>(`/hoteles/${hotelId}/mantenimiento`);
}

export async function crearTicketMantenimiento(
  hotelId: string,
  input: { roomCode?: string; title: string; description: string; severity: "alta" | "media" | "baja"; estimatedCost?: number },
): Promise<{ ticketId: string; duplicate?: boolean }> {
  return request(`/hoteles/${hotelId}/mantenimiento`, { method: "POST", body: JSON.stringify(input) });
}

export async function cerrarTicketConCosto(
  hotelId: string,
  ticketId: string,
  input: { actualCost: number; partUsed?: string; resolutionNote?: string },
): Promise<{ estado: string; aprobacionId: string }> {
  return request(`/hoteles/${hotelId}/mantenimiento/${ticketId}/cerrar-con-costo`, { method: "POST", body: JSON.stringify(input) });
}

export interface SolicitudAprobacion {
  id: string;
  tool: string;
  textoMostrado: string;
  resumenInput: string;
  solicitadoPor: string;
  esDinero: boolean;
  confirmacionesRequeridas: number;
  estado: "pendiente" | "aprobada" | "rechazada" | "expirada";
  solicitadoEn: string;
  expiraEn: string;
}

export async function listarAprobaciones(hotelId: string, estado?: string): Promise<SolicitudAprobacion[]> {
  const qs = estado ? `?estado=${estado}` : "";
  return request<SolicitudAprobacion[]>(`/hoteles/${hotelId}/aprobaciones${qs}`);
}

export async function decidirAprobacion(
  hotelId: string,
  aprobacionId: string,
  input: { decision: "aprobar" | "rechazar"; textoExacto: string },
): Promise<{ estado: string; ejecutado?: boolean }> {
  return request(`/hoteles/${hotelId}/aprobaciones/${aprobacionId}/decidir`, { method: "POST", body: JSON.stringify(input) });
}

export interface HiloMensaje {
  id: string;
  direccion: "entrante" | "saliente";
  canal: string;
  plantilla: string | null;
  texto: string;
  estadoEntrega: string | null;
  simulado: boolean;
  creadoEn: string;
}

export async function listarMensajesConversacion(hotelId: string, conversationId: string): Promise<HiloMensaje[]> {
  return request<HiloMensaje[]>(`/hoteles/${hotelId}/mensajeria/${conversationId}/mensajes`);
}

export async function enviarMensajeWhatsapp(
  hotelId: string,
  input: { guestPhone: string; templateName: string; languageCode?: string; parameters?: string[] },
): Promise<{ estado: string; aprobacionId?: string }> {
  return request(`/hoteles/${hotelId}/mensajeria/mensajes`, { method: "POST", body: JSON.stringify(input) });
}

export async function obtenerConfigMensajeria(hotelId: string): Promise<{ plantillasTransaccionales: string[] }> {
  return request(`/hoteles/${hotelId}/mensajeria/config`);
}

export async function actualizarConfigMensajeria(hotelId: string, plantillasTransaccionales: string[]): Promise<{ plantillasTransaccionales: string[] }> {
  return request(`/hoteles/${hotelId}/mensajeria/config`, { method: "PATCH", body: JSON.stringify({ plantillasTransaccionales }) });
}
