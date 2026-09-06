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

// ---- Folio: cargos/pagos/descuentos/reverso/transferencia/split/cierre (H5) ----

export type ConceptoCargo = "hospedaje" | "ab" | "extras" | "ajuste" | "propina" | "otro";

export interface CargoFolio {
  id: string;
  concepto: string;
  descripcion: string;
  monto: number;
  impuesto: number;
  revertidoPor: string | null;
  reversaDe: string | null;
  transferidoDe: string | null;
  creadoEn: string;
}

export interface PagoFolio {
  id: string;
  monto: number;
  metodo: string;
  estado: string;
  referenciaExterna: string | null;
  creadoEn: string;
}

export interface Folio {
  id: string;
  estado: "abierto" | "cerrado";
  reservationId: string;
  etiqueta: string;
  esPrincipal: boolean;
  cerradoEn: string | null;
  motivoCierre: string | null;
  cargos: CargoFolio[];
  pagos: PagoFolio[];
  saldo: number;
}

function claveIdempotenciaFolio(): string {
  return crypto.randomUUID();
}

export async function obtenerFolio(hotelId: string, folioId: string): Promise<Folio> {
  return request<Folio>(`/hoteles/${hotelId}/folios/${folioId}`);
}

export async function listarFoliosDeReserva(hotelId: string, reservationId: string): Promise<Folio[]> {
  return request<Folio[]>(`/hoteles/${hotelId}/reservas/${reservationId}/folios`);
}

export async function crearCargo(
  hotelId: string,
  folioId: string,
  input: { descripcion: string; monto: number; concepto: ConceptoCargo },
): Promise<{ id: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify(input),
  });
}

export async function crearDescuento(
  hotelId: string,
  folioId: string,
  input: { descripcion: string; monto: number; autorizadoPorUserId?: string | null },
): Promise<{ id: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/descuentos`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify(input),
  });
}

export async function reversarCargo(hotelId: string, folioId: string, chargeId: string, motivo: string): Promise<{ id: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cargos/${chargeId}/reverso`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify({ motivo }),
  });
}

export async function transferirCargo(
  hotelId: string,
  folioId: string,
  chargeId: string,
  folioDestinoId: string,
): Promise<{ id: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cargos/${chargeId}/transferir`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify({ folioDestinoId }),
  });
}

export async function splitFolio(hotelId: string, folioId: string, etiqueta: string, chargeIds: string[]): Promise<{ id: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/split`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify({ etiqueta, chargeIds }),
  });
}

export async function crearPago(
  hotelId: string,
  folioId: string,
  input: { monto: number; metodo: "efectivo" | "transferencia" | "tarjeta"; tokenPago?: string },
): Promise<{ id: string; estado: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify(input),
  });
}

export async function cerrarFolio(
  hotelId: string,
  folioId: string,
  input: { motivo: "saldo_cero" | "cuenta_por_cobrar"; autorizadoPorUserId?: string | null },
): Promise<{ id: string; estado: string; saldo: number }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cerrar`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Night audit (H5) ----

export interface NightAuditSummary {
  businessDate: string;
  postedCharges: { reservationId: string; folioId: string; amount: number; taxAmount: number }[];
  noShows: { reservationId: string; chargeAmount: number }[];
  cargosPorConcepto: Record<string, number>;
  pagosPorMetodo: Record<string, number>;
  ocupacion: { enCasa: number };
  conciliacionAB: { estado: string };
  yaCompletado: boolean;
}

export interface NightAuditHistorialFila {
  fecha: string;
  estado: string;
  completadoEn: string | null;
}

export async function ejecutarNightAudit(hotelId: string, businessDate?: string): Promise<NightAuditSummary> {
  return request(`/hoteles/${hotelId}/night-audit`, { method: "POST", body: JSON.stringify({ businessDate }) });
}

export async function listarNightAuditHistorial(hotelId: string): Promise<NightAuditHistorialFila[]> {
  return request(`/hoteles/${hotelId}/night-audit`);
}

// ---- CFDI de hospedaje (H5, pendiente de PAC real) ----

export interface CfdiEmitido {
  id: string;
  folioId: string;
  tipo: "hospedaje" | "pago";
  uuidFiscal: string | null;
  estado: string;
  pac: string | null;
  subtotal: number;
  iva: number;
  total: number;
  rfcReceptor: string;
  esExtranjero: boolean;
  esGlobal: boolean;
  esNoShow: boolean;
  creadoEn: string;
  canceladoEn: string | null;
}

export async function listarCfdiDelHotel(hotelId: string): Promise<CfdiEmitido[]> {
  return request(`/hoteles/${hotelId}/cfdi`);
}

export async function listarCfdiDeFolio(hotelId: string, folioId: string): Promise<CfdiEmitido[]> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`);
}

export async function emitirCfdiHospedaje(
  hotelId: string,
  folioId: string,
  input: { rfcReceptor?: string; usoCfdi?: string; metodoPago: "PUE" | "PPD"; esExtranjero?: boolean; esGlobal?: boolean },
): Promise<{ id: string; uuidFiscal: string; estado: string }> {
  return request(`/hoteles/${hotelId}/folios/${folioId}/cfdi`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify(input),
  });
}

export async function cancelarCfdi(hotelId: string, cfdiId: string, motivo: "01" | "02" | "03" | "04"): Promise<{ id: string; estado: string }> {
  return request(`/hoteles/${hotelId}/cfdi/${cfdiId}/cancelar`, {
    method: "POST",
    headers: { "idempotency-key": claveIdempotenciaFolio() },
    body: JSON.stringify({ motivo }),
  });
}
